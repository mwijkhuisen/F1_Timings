// The only module that imports ECharts at runtime. LapChart loads it with a dynamic import(),
// so ECharts stays out of the initial bundle (A§3, D3); test/build.test.ts checks that.
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export { init };
