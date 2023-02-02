import React from 'react';
import {
  PieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  Label,
  Legend,
} from 'recharts';
import { colors } from '../helper/common';

const DoughnutChart = (props: { data: Array<any>; label: string }) => {
  const { data, label } = props;
  data.map((segment, i) => (segment.fill = colors[i]));

  return (
    <ResponsiveContainer debounce={1} maxHeight={300} width="100%" aspect={1.4}>
      <PieChart>
        <Pie
          data={data}
          isAnimationActive={false}
          nameKey="type"
          dataKey="value"
          innerRadius="60%"
          outerRadius="95%"
          fill="#197396"
        >
          <Label
            value={label}
            position="center"
            style={{
              fontWeight: 'bold',
              fill: '#03A678',
            }}
          />
        </Pie>
        <Legend />
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default DoughnutChart;
