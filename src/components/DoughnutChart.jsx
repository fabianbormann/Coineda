import {
  PieChart,
  Pie,
  ResponsiveContainer,
  Legend,
  Tooltip,
  Label,
} from 'recharts';
import { createUseStyles } from 'react-jss';
import useWindowDimensions from '../helper/WindowDimensions';

const colors = [
  '#03A678',
  '#4C75A9',
  '#7D73AF',
  '#AA6FA6',
  '#CB6E91',
  '#009482',
  '#008183',
  '#006E7C',
  '#1E5A6D',
  '#2F4858',
  '#BE76B8',
  '#F980A4',
  '#FF9C84',
  '#FFC86B',
  '#F9F871',
  '#0084BC',
  '#0089AA',
  '#008D8B',
  '#2DAC8D',
  '#6BC985',
  '#AEE379',
  '#F9F871',
  '#197396',
];

const useStyles = createUseStyles({
  pie: {
    '& .recharts-legend-wrapper': {
      height: '95% !important',
      overflowY: 'auto',
    },
  },
});

const DoughnutChart = (props) => {
  const { data, label } = props;
  const classes = useStyles();
  const { width } = useWindowDimensions();
  data.map((segment, i) => (segment.fill = colors[i]));

  return (
    <ResponsiveContainer minHeight={256}>
      <PieChart className={classes.pie}>
        <Pie
          cx={width < 620 ? 100 : 150}
          data={data}
          isAnimationActive={false}
          nameKey="type"
          dataKey="value"
          innerRadius="50%"
          fill="#197396"
        >
          <Label
            value={label}
            position="center"
            style={{ fontWeight: 'bold', fontSize: '1.1rem', fill: '#03A678' }}
          />
        </Pie>
        <Tooltip />
        <Legend layout="vertical" align="right" verticalAlign="top" />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default DoughnutChart;
