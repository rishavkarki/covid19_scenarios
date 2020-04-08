import * as math from 'mathjs'

import { OneCountryAgeDistribution } from '../assets/data/CountryAgeDistribution.types'

import { SeverityTableRow } from '../components/Main/Scenario/SeverityTable'

import { collectTotals, evolve, getPopulationParams, initializePopulation } from './model'
import { AllParamsFlat, MitigationIntervals } from './types/Param.types'
import { AlgorithmResult, SimulationTimePoint, ExportedTimePoint } from './types/Result.types'
import { TimeSeries } from './types/TimeSeries.types'

const identity = (x: number) => x
const poisson = (x: number) => {
  throw new Error('We removed dependency on `random` package. Currently `poisson` is not implemented')
}

interface ChangePoint {
  t: Date
  val: Number[]
}

const compareTimes = (a: ChangePoint, b: ChangePoint): number => {
  return a.t.valueOf() - b.t.valueOf()
}

// NOTE: Assumes containment is sorted ascending in time.
export function interpolateTimeSeries(containment: TimeSeries): (t: Date) => number {
  if (containment.length === 0) {
    return (t: Date) => 1.0
  }
  const Ys = containment.map((d) => d.y)
  const Ts = containment.map((d) => Number(d.t))
  return (t: Date) => {
    if (t <= containment[0].t) {
      return containment[0].y
    }
    if (t >= containment[containment.length - 1].t) {
      return containment[containment.length - 1].y
    }
    const i = containment.findIndex((d) => Number(t) < Number(d.t))

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const evalLinear = (t: number) => {
      const deltaY = Ys[i] - Ys[i - 1]
      const deltaT = Ts[i] - Ts[i - 1]

      const dS = deltaY / deltaT
      const dT = t - Ts[i - 1]

      return Ys[i - 1] + dS * dT
    }

    return evalLinear(Number(t))
  }
}

export function intervalsToTimeSeries(intervals: MitigationIntervals): TimeSeries {
  const changePoints = {}
  intervals.forEach((element) => {
    // bound the value by 0.01 and 100 (transmission can be at most 100 fold reduced or increased)
    const val = Math.min(Math.max(1 - element.mitigationValue * 0.01, 0.01), 100)

    if (changePoints[element.timeRange.tMin] !== undefined) {
      changePoints[element.timeRange.tMin].push(val)
    } else {
      changePoints[element.timeRange.tMin] = [val]
    }
    // add inverse of the value when measure is relaxed
    if (changePoints[element.timeRange.tMax] !== undefined) {
      changePoints[element.timeRange.tMax].push(1.0 / val)
    } else {
      changePoints[element.timeRange.tMax] = [1.0 / val]
    }
  })

  const orderedChangePoints: ChangePoint[] = Object.keys(changePoints).map((d) => ({
    t: new Date(d),
    val: changePoints[d],
  }))

  orderedChangePoints.sort(compareTimes)

  if (orderedChangePoints.length) {
    const mitigationSeries: TimeSeries = [{ t: orderedChangePoints[0].t, y: 1.0 }]
    const product = (a: Number, b: Number): Number => a * b

    orderedChangePoints.forEach((d, i) => {
      const prevValue = mitigationSeries[2 * i].y
      const newValue = d.val.reduce(product, prevValue)
      mitigationSeries.push({ t: d.t, y: prevValue })
      mitigationSeries.push({ t: d.t, y: newValue })
    })
    return mitigationSeries
  }
  return []
}

function ensurePositive(x: ExportedTimePoint): ExportedTimePoint {
  const check = (obj: Record<string, number>) => {
    Object.keys(obj).forEach((k) => {
      if (obj[k] < 0) {
        obj[k] = 0
      }
    })

    return obj
  }

  x.current.susceptible = check(x.current.susceptible)
  x.current.severe = check(x.current.severe)
  x.current.exposed = check(x.current.exposed)
  x.current.critical = check(x.current.critical)
  x.current.overflow = check(x.current.overflow)
  x.current.infectious = check(x.current.infectious)

  x.cumulative.critical = check(x.cumulative.critical)
  x.cumulative.fatality = check(x.cumulative.fatality)
  x.cumulative.recovered = check(x.cumulative.recovered)
  x.cumulative.hospitalized = check(x.cumulative.hospitalized)

  return x
}

function sumTimePoint(x: ExportedTimePoint, y: ExportedTimePoint, func: (x: number) => number): ExportedTimePoint {
  const sum = (dict: Record<string, number>, other: Record<string, number>): Record<string, number> => {
    const s: Record<string, number> = {}
    Object.keys(other).forEach((k) => {
      if (!(k in dict)) {
        s[k] = func(other[k])
      } else {
        s[k] = dict[k] + func(other[k])
      }
    })

    return s
  }

  const z: ExportedTimePoint = {
    time: y.time,
    current: {
      susceptible: sum(x.current.susceptible, y.current.susceptible),
      severe: sum(x.current.severe, y.current.severe),
      exposed: sum(x.current.exposed, y.current.exposed),
      critical: sum(x.current.critical, y.current.critical),
      overflow: sum(x.current.overflow, y.current.overflow),
      infectious: sum(x.current.infectious, y.current.infectious),
    },
    cumulative: {
      critical: sum(x.cumulative.critical, y.cumulative.critical),
      fatality: sum(x.cumulative.fatality, y.cumulative.fatality),
      recovered: sum(x.cumulative.recovered, y.cumulative.recovered),
      hospitalized: sum(x.cumulative.hospitalized, y.cumulative.hospitalized),
    },
  }

  return z
}

function zeroTrajectory(len: number): ExportedTimePoint[] {
  const arr: ExportedTimePoint[] = []
  while (arr.length < len) {
    arr.push({
      time: Date.now(), // Dummy
      current: {
        susceptible: {},
        severe: {},
        critical: {},
        exposed: {},
        infectious: {},
        overflow: {},
      },
      cumulative: {
        recovered: {},
        critical: {},
        hospitalized: {},
        fatality: {},
      },
    })
  }

  return arr
}

/**
 *
 * Entry point for the algorithm
 *
 */
export async function run(
  params: AllParamsFlat,
  severity: SeverityTableRow[],
  ageDistribution: OneCountryAgeDistribution,
  containment: TimeSeries,
): Promise<AlgorithmResult> {
  const tMin: number = new Date(params.simulationTimeRange.tMin).getTime()
  const tMax: number = new Date(params.simulationTimeRange.tMax).getTime()
  const ageGroups = Object.keys(ageDistribution)
  const initialCases = params.suspectedCasesToday
  const modelParamsArray = getPopulationParams(params, severity, ageDistribution, interpolateTimeSeries(containment))

  const msPerDay = 24 * 60 * 60 * 1000
  const numDaysDelta = Math.round((tMax - tMin) / msPerDay)
  const avgLinear: ExportedTimePoint[] = zeroTrajectory(numDaysDelta)
  const avgSquare: ExportedTimePoint[] = zeroTrajectory(numDaysDelta)

  modelParamsArray.forEach((modelParams) => {
    let population = initializePopulation(modelParams.populationServed, initialCases, tMin, ageDistribution)

    function simulate(initialState: SimulationTimePoint, func: (x: number) => number): ExportedTimePoint[] {
      const dynamics = [initialState]
      let currState = initialState

      while (currState.time < tMax) {
        currState = evolve(currState, modelParams, currState.time + 1, func)
        dynamics.push(currState)
      }

      return collectTotals(dynamics, ageGroups)
    }

    const realization = simulate(population, identity)

    avgLinear.forEach((tp, i) => {
      avgLinear[i] = sumTimePoint(tp, realization[i], (x) => {
        return x / modelParamsArray.length
      })
    })

    avgSquare.forEach((tp, i) => {
      avgSquare[i] = sumTimePoint(tp, realization[i], (x) => {
        return (x * x) / modelParamsArray.length
      })
    })
  })

  const sim: AlgorithmResult = {
    trajectory: {
      mean: avgLinear,
      variance: avgSquare.map((tp, i) => ensurePositive(sumTimePoint(tp, avgLinear[i], (x: number) => -x * x))),
    },
  }

  return sim
}
