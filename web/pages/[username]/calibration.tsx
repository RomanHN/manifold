import dynamic from 'next/dynamic'
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as any

import { Col } from 'web/components/layout/col'
import { Title } from 'web/components/widgets/title'
import { Page } from 'web/components/layout/page'
import { SEO } from 'web/components/SEO'
import { Dictionary, range } from 'lodash'
import { getUserByUsername, User } from 'web/lib/firebase/users'
import { useEffect, useState } from 'react'
import { getUserBetsFromResolvedContracts } from 'web/lib/supabase/bets'
import { Bet, LimitBet } from 'common/bet'
import { Contract } from 'common/contract'
import { LoadingIndicator } from 'web/components/widgets/loading-indicator'

export const getStaticProps = async (props: {
  params: {
    username: string
  }
}) => {
  const { username } = props.params
  const user = await getUserByUsername(username)

  return {
    props: { user },
    revalidate: 60, // Regenerate after 60 second
  }
}

export async function getStaticPaths() {
  return { paths: [], fallback: 'blocking' }
}

export default function CalibrationPage(props: { user: User | null }) {
  const { user } = props
  const domain = range(0, 1.01, 0.01)

  const [yesProbBuckets, setYesProbBuckets] = useState<Dictionary<number>>({})
  const [noProbBuckets, setNoProbBuckets] = useState<Dictionary<number>>({})

  const isLoading = Object.keys(yesProbBuckets).length === 0

  const score = !isLoading
    ? calculateScore(yesProbBuckets, noProbBuckets)
    : undefined

  useEffect(() => {
    if (!user) return

    getUserBetsFromResolvedContracts(user.id, 25000).then(
      (betsWithContracts) => {
        const [yesBuckets, noBuckets] = getCalibrationPoints(betsWithContracts)
        setYesProbBuckets(yesBuckets)
        setNoProbBuckets(noBuckets)
      }
    )
  }, [user])

  return (
    <Page>
      <SEO title="Calibration" description="Personal calibration results" />
      <Col className="w-full rounded px-4 py-6 sm:px-8 xl:w-[125%]">
        <Col className="">
          <Title>Calibration</Title>
          {isLoading ? (
            <LoadingIndicator />
          ) : (
            <>
              <Plot
                data={[
                  {
                    ...getXY(yesProbBuckets),
                    mode: 'markers',
                    type: 'scatter',
                    marker: { color: 'green' },
                    name: 'YES bets',
                  },
                  {
                    ...getXY(noProbBuckets),
                    mode: 'markers',
                    type: 'scatter',
                    marker: { color: 'red' },
                    name: 'NO bets',
                  },
                  {
                    x: domain,
                    y: domain,
                    mode: 'lines',
                    type: 'scatter',
                    marker: { color: 'gray' },
                    name: 'y=x',
                  },
                ]}
                layout={{
                  width: 800,
                  height: 500,
                  title:
                    user?.name +
                    "'s bet calibration" +
                    (score !== undefined ? ` (score: ${score})` : ''),
                  xaxis: { title: 'Probability after bet' },
                  yaxis: { title: 'Resolution probability' },
                }}
              />
              <div className="max-w-2xl text-sm">
                Interpretation: The green dot at (x%, y%) means when{' '}
                {user?.name} bet YES at x%, the market resolved YES y% of the
                time on average. Perfect calibration would result in all green
                points being above the line, all red points below, and a score
                of zero. The score is the mean squared error for yes and no bets
                times -100. Each point is a bucket of bets weighted by bet
                amount with a maximum size of 10% (sold bets are excluded).
              </div>
            </>
          )}
        </Col>
      </Col>
    </Page>
  )
}

const points = [1, 3, 5, ...range(10, 100, 10), 95, 97, 99]

const getCalibrationPoints = (betsData: [Contract, LimitBet[]][]) => {
  const yesProbBuckets: Dictionary<number> = {}
  const yesCountBuckets: Dictionary<number> = {}

  const noProbBuckets: Dictionary<number> = {}
  const noCountBuckets: Dictionary<number> = {}

  for (const [contract, bets] of betsData) {
    const { resolution } = contract
    if (resolution !== 'YES' && resolution !== 'NO') continue
    const resolvedYES = resolution === 'YES'

    for (const bet of bets as Bet[]) {
      if (bet.amount < 0) continue // skip sales

      const rawP = bet.probAfter * 100

      // get probability bucket that's closest to a prespecified point
      const p = points.reduce((prev, curr) =>
        Math.abs(curr - rawP) < Math.abs(prev - rawP) ? curr : prev
      )

      const w = bet.amount // weight by bet amount

      if (bet.outcome === 'YES') {
        yesProbBuckets[p] = (yesProbBuckets[p] ?? 0) + (resolvedYES ? w : 0)
        yesCountBuckets[p] = (yesCountBuckets[p] ?? 0) + w
      } else {
        noProbBuckets[p] = (noProbBuckets[p] ?? 0) + (resolvedYES ? 0 : w)
        noCountBuckets[p] = (noCountBuckets[p] ?? 0) + w
      }
    }
  }

  for (const point of points) {
    if (yesCountBuckets[point]) {
      yesProbBuckets[point] = yesProbBuckets[point] / yesCountBuckets[point]
    }

    if (noCountBuckets[point]) {
      noProbBuckets[point] = 1 - noProbBuckets[point] / noCountBuckets[point]
    }
  }

  return [yesProbBuckets, noProbBuckets]
}

const getXY = (probBuckets: Dictionary<number>) => {
  const x = []
  const y = []

  for (const point of points) {
    if (probBuckets[point] !== undefined) {
      x.push(point / 100)
      y.push(probBuckets[point])
    }
  }

  return { x, y }
}

const calculateScore = (
  yesBuckets: Dictionary<number>,
  noBuckets: Dictionary<number>
) => {
  let score = 0
  let n = 0

  for (const point of points) {
    const prob = point / 100
    const yes = yesBuckets[point]
    const no = noBuckets[point]

    if (yes !== undefined) {
      score += yes < prob ? (prob - yes) ** 2 : 0
      n++
    }

    if (no !== undefined) {
      score += no > prob ? (no - prob) ** 2 : 0
      n++
    }
  }

  const raw = score / n
  return (-100 * Math.round(raw * 1e4)) / 1e4
}
