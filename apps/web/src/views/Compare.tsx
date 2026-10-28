import { LapChart } from './LapChart.tsx';

// Placeholder: step B fills this in (drivers, option builder, delta table).
const option = {
  xAxis: { type: 'category', data: [1, 2, 3] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [3, 1, 2] }],
};

export function Compare() {
  return <LapChart option={option} label="Lap times" />;
}
