import {
  PieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  Label,
  Legend,
} from 'recharts';
import { colors } from '../helper/common';
import { createUseStyles } from 'react-jss';

const useStyles = createUseStyles({
  pie: {
    fontWeight: 'bold',
    fontSize: '0.5rem',
    fill: '#03A678',
    '@media screen and (min-width: 360px)': {
      fontSize: '0.75rem',
    },
    '@media screen and (min-width: 420px)': {
      fontSize: '1rem',
    },
    '@media screen and (min-width: 800px)': {
      fontSize: '1.5rem',
    },
  },
});

const DoughnutChart = (props) => {
  const { data, label } = props;
  const classes = useStyles();
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
          <Label value={label} position="center" className={classes.pie} />
        </Pie>
        <Legend />
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default DoughnutChart;
