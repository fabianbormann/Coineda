import { Collapse, Typography, Timeline } from 'antd';
import { createUseStyles } from 'react-jss';
import { useTranslation } from 'react-i18next';
import moment from 'moment';

const { Panel } = Collapse;
const { Title } = Typography;

const useStyles = createUseStyles({
  collapse: {
    maxWidth: 600,
  },
  panel: {
    display: 'inline-block',
    width: 'calc(100% - 32px)',
  },
  negative: {
    color: '#cf1322',
  },
  positive: {
    color: '#3f8600',
  },
  title: {
    marginTop: 12,
    marginBottom: 12,
  },
});

const GainSummary = (props) => {
  const { gains, title } = props;
  const { t } = useTranslation();

  const classes = useStyles();

  if (typeof gains === 'undefined' || gains.length === 0) {
    return null;
  }

  const roundFiat = (value) => Math.round(value * 100) / 100;
  const roundCrypto = (value) => Math.round(value * 100000) / 100000;

  return (
    <>
      {title && (
        <Title className={classes.title} level={4}>
          {title}
        </Title>
      )}
      <Collapse className={classes.collapse}>
        {Object.keys(gains).map((coin, key) => {
          if (gains[coin].length === 0) {
            return null;
          }

          const amount = gains[coin].reduce(
            (previous, current) => previous + (current.amount || 0),
            0
          );

          if (amount === 0) {
            return null;
          }

          const gain = gains[coin].reduce(
            (previous, current) => previous + current.gain,
            0
          );

          return (
            <Panel
              header={
                <span className={classes.panel}>
                  <div style={{ display: 'flex' }}>
                    <span>{`${roundCrypto(amount)} ${gains[
                      coin
                    ][0].symbol.toUpperCase()}`}</span>
                    <span style={{ flexGrow: 1 }}></span>
                    <span
                      className={gain < 0 ? classes.negative : classes.positive}
                    >{`${roundFiat(gain)} EUR`}</span>
                  </div>
                </span>
              }
              key={key}
            >
              <Timeline>
                {gains[coin].map((transaction) => (
                  <Timeline.Item
                    color={transaction.type === 'buy' ? 'green' : 'red'}
                  >
                    {transaction.type === 'buy'
                      ? t('Bought asset summary', {
                          value: roundCrypto(transaction.toValue),
                          symbol: transaction.symbol.toUpperCase(),
                          date: moment(transaction.date).format('DD.MM.YYYY'),
                          fiat: `${roundFiat(transaction.fromValue)} EUR`,
                        })
                      : t('Selled asset summary', {
                          value: roundCrypto(transaction.toValue),
                          symbol: transaction.symbol.toUpperCase(),
                          date: moment(transaction.date).format('DD.MM.YYYY'),
                          fiat: `${roundFiat(transaction.fromValue)} EUR`,
                        })}
                  </Timeline.Item>
                ))}
              </Timeline>
            </Panel>
          );
        })}
      </Collapse>
    </>
  );
};

export default GainSummary;
