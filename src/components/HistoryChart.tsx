import React from 'react';
import { useEffect, useState, useContext } from 'react';
import {
  ResponsiveContainer,
  Line,
  LineChart,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
} from 'recharts';
import { fetchPrice, getCoinCount, getPurchaseValue } from '../helper/common';
import { SettingsContext } from '../SettingsContext';

const HistoryChart = () => {
  //const { currencies } = props;
  const { settings } = useContext(SettingsContext);
  const [data, setData] = useState([]);
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [state, setState] = useState('LOADING');

  const { account } = settings;

  /*useEffect(() => {
    const calculatePurchasePrice = async () => {
      let value = 0;
      for (const currency of currencies) {
        value += await getPurchaseValue(currency, account.id);
      }
      setPurchasePrice(value);
    };

    const collectData = async () => {
      const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      const today = new Date();

      try {
        let marketPrices = [];
        for (var i = 6; i >= 0; i -= 1) {
          const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
          const month = monthNames[date.getMonth()];

          let values = {};

          if (i === 0) {
            values = await fetchPrice(currencies);
          } else {
            for (const currency of currencies) {
              let currencyPrice = await fetchPrice(currency, date);
              values[currency] = currencyPrice;
            }
          }

          let marketPrice = 0;
          for (const currency in values) {
            let currencyCount = await getCoinCount(currency, date, account.id);
            marketPrice += values[currency] * currencyCount;
          }

          marketPrices.push({
            name: month,
            short: month.substring(0, 3),
            unit: 'Eur',
            Value: Math.round(marketPrice * 100) / 100,
          });
        }
        setData(marketPrices);
        setState('READY');
      } catch (error) {
        console.warn(error);
        setState('ERROR');
      }
    };

    collectData();
    calculatePurchasePrice();
  }, [currencies, account]);

  let content = (
    <div className={classes.wrapper}>
      <Spin />
    </div>
  );
  if (state === 'ERROR') {
    content = (
      <div className={classes.wrapper}>
        <Result
          status="warning"
          title="Error while fetching historical data."
        />
      </div>
    );
  } else if (state === 'READY') {
    content = (
      <LineChart data={data}>
        <XAxis dataKey="short" />
        <YAxis domain={['auto', 'auto']} />
        <Tooltip
          labelFormatter={(label, payload) => {
            if (payload.length > 0) {
              return payload[0].payload.name;
            }
            return label;
          }}
          formatter={(value, name, props) => value + ' €'}
        />
        <Line
          type="monotone"
          dot={false}
          dataKey="Value"
          stroke="#03A678"
          strokeWidth={2}
        />
        <ReferenceLine y={purchasePrice} stroke="#4C75A9"></ReferenceLine>
      </LineChart>
    );
  }

  return (
    <ResponsiveContainer debounce={1} maxHeight={300} width="100%" aspect={1.4}>
      {content}
    </ResponsiveContainer>
  );*/

  return <div></div>;
};

export default HistoryChart;
