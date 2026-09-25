import React from 'react'
import type { BenchmarkMetrics } from './types'

const WIDTH = 920
const HEIGHT = 390
const PLOT = { left: 62, right: 22, top: 74, bottom: 326 }
const METRICS: readonly { key: keyof Pick<BenchmarkMetrics, 'top1' | 'top5' | 'top10' | 'mAP'>; label: string }[] = [
  { key: 'top1', label: 'R@1' },
  { key: 'top5', label: 'R@5' },
  { key: 'top10', label: 'R@10' },
  { key: 'mAP', label: 'mAP' },
]
const TICKS = [0, 25, 50, 75, 100]
const BAR_WIDTH = 34
const BAR_GAP = 2

type Series = 'baseline' | 'finetuned'
type ActiveBar = { x: number; y: number; label: string } | null

function roundedTopPath(x: number, y: number, width: number, bottom: number): string {
  const radius = Math.min(4, Math.max(0, (bottom - y) / 2))
  return [
    `M ${x} ${bottom}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + width - radius} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + radius}`,
    `L ${x + width} ${bottom}`,
    'Z',
  ].join(' ')
}

export function BenchmarkChart(props: {
  baselineLabel: string
  baseline: BenchmarkMetrics
  fineTunedLabel: string
  fineTuned: BenchmarkMetrics
}) {
  const [activeBar, setActiveBar] = React.useState<ActiveBar>(null)
  const plotHeight = PLOT.bottom - PLOT.top
  const plotWidth = WIDTH - PLOT.left - PLOT.right
  const tooltipWidth = 340

  function renderSeries(
    series: Series,
    modelLabel: string,
    metrics: BenchmarkMetrics,
    x: number,
    metricLabel: string,
  ) {
    const value = metrics[metricKey(metricLabel)] * 100
    const bounded = Math.max(0, Math.min(100, value))
    const barHeight = plotHeight * bounded / 100
    const y = PLOT.bottom - barHeight
    const tooltip = `${modelLabel} · ${metricLabel} · ${value.toFixed(1)}%`
    const tooltipX = Math.max(4, Math.min(WIDTH - tooltipWidth - 4, x + BAR_WIDTH / 2 - tooltipWidth / 2))

    return <g
      key={`${series}-${metricLabel}`}
      className={`benchmark-bar benchmark-bar-${series}`}
      tabIndex={0}
      role="img"
      aria-label={tooltip}
      onPointerEnter={() => setActiveBar({ x: tooltipX, y: Math.max(4, y - 48), label: tooltip })}
      onPointerLeave={() => setActiveBar(null)}
      onFocus={() => setActiveBar({ x: tooltipX, y: Math.max(4, y - 48), label: tooltip })}
      onBlur={() => setActiveBar(null)}
    >
      <rect
        className="benchmark-bar-hit-area"
        x={x - 2}
        y={PLOT.top}
        width={BAR_WIDTH + 4}
        height={plotHeight}
        rx={2}
      />
      <path className="benchmark-bar-mark" d={roundedTopPath(x, y, BAR_WIDTH, PLOT.bottom)}/>
      <text className="benchmark-value" x={x + BAR_WIDTH / 2} y={Math.max(PLOT.top - 6, y - 8)} textAnchor="middle">{value.toFixed(1)}</text>
    </g>
  }

  return <div className="benchmark-chart-frame">
    <div className="chart-legend" aria-hidden="true">
      <span><i className="legend-swatch baseline-swatch"/>{props.baselineLabel}</span>
      <span><i className="legend-swatch finetuned-swatch"/>{props.fineTunedLabel}</span>
    </div>
    <svg
      className="benchmark-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="group"
      aria-labelledby="benchmark-chart-title"
      aria-describedby="benchmark-chart-description"
    >
      <title id="benchmark-chart-title">Benchmark metrics: {props.fineTunedLabel} vs {props.baselineLabel}</title>
      <desc id="benchmark-chart-description">Grouped bars compare R@1, R@5, R@10, and mAP on a zero to one hundred percent scale. The table above provides the same metrics in tabular form.</desc>
      {TICKS.map(tick => {
        const y = PLOT.bottom - plotHeight * tick / 100
        return <g key={tick} className="chart-axis-tick">
          <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={y} y2={y}/>
          <text x={PLOT.left - 12} y={y + 4} textAnchor="end">{tick}</text>
        </g>
      })}
      {METRICS.map((metric, index) => {
        const center = PLOT.left + plotWidth * (index + .5) / METRICS.length
        const groupWidth = BAR_WIDTH * 2 + BAR_GAP
        const baselineX = center - groupWidth / 2
        const fineTunedX = baselineX + BAR_WIDTH + BAR_GAP
        return <g key={metric.key} className="chart-category">
          {renderSeries('baseline', props.baselineLabel, props.baseline, baselineX, metric.label)}
          {renderSeries('finetuned', props.fineTunedLabel, props.fineTuned, fineTunedX, metric.label)}
          <text className="chart-category-label" x={center} y={PLOT.bottom + 28} textAnchor="middle">{metric.label}</text>
        </g>
      })}
      {activeBar && <g className="chart-tooltip" aria-hidden="true">
        <rect x={activeBar.x} y={activeBar.y} width={tooltipWidth} height={32} rx={3}/>
        <text x={activeBar.x + 10} y={activeBar.y + 21}>{activeBar.label}</text>
      </g>}
    </svg>
  </div>
}

function metricKey(label: string): keyof Pick<BenchmarkMetrics, 'top1' | 'top5' | 'top10' | 'mAP'> {
  if (label === 'R@1') return 'top1'
  if (label === 'R@5') return 'top5'
  if (label === 'R@10') return 'top10'
  return 'mAP'
}
