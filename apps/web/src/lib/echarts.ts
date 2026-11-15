// The only module that imports ECharts at runtime. views/Chart.tsx loads it with a dynamic import(),
// so ECharts stays out of the initial bundle (A§3, D3); test/build.test.ts checks that.
import { LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

// MarkArea draws the SC, VSC and red-flag bands; ScatterChart the track evolution's laps (#114); LabelLayout keeps the end labels apart (moveOverlap).
use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  LabelLayout,
  CanvasRenderer,
]);

export { init };
