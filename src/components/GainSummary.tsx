import { useTranslation } from 'react-i18next';
import moment from 'moment';
import React from 'react';

const GainSummary = (props: {
  gains: Array<any>;
  showUnrealizedGains: boolean;
}) => {
  const { gains, showUnrealizedGains } = props;
  const { t } = useTranslation();

  let title = t('Realized Gains');
  if (showUnrealizedGains) {
    title = t('Unrealized Gains');
  }

  if (typeof gains === 'undefined' || gains.length === 0) {
    return null;
  }

  const roundFiat = (value: number) => Math.round(value * 100) / 100;
  const roundCrypto = (value: number) => Math.round(value * 100000) / 100000;
  /*
  return (
    <>
      {title && <p className={classes.title}>{title}</p>}
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
              {showUnrealizedGains ? (
                <Timeline>
                  {gains[coin].map((transaction, key) =>
                    transaction.value > 0 ? (
                      <Timeline.Item key={key}>
                        <div>
                          <Progress
                            showInfo={false}
                            percent={Math.min(
                              100,
                              (transaction.daysFromPurchase / 366) * 100
                            )}
                          />
                          <p>
                            {t('Asset becomes tax free', {
                              value: roundCrypto(transaction.value),
                              symbol: transaction.symbol.toUpperCase(),
                              days: Math.max(
                                0,
                                366 - transaction.daysFromPurchase
                              ),
                              gain: `${roundFiat(transaction.gain)} EUR`,
                            })}
                          </p>
                        </div>
                      </Timeline.Item>
                    ) : null
                  )}
                </Timeline>
              ) : (
                <Timeline>
                  {gains[coin].map((transaction, key) => (
                    <Timeline.Item
                      key={key}
                      color={transaction.type === 'buy' ? '#03A678' : '#C36491'}
                    >
                      {transaction.type === 'buy' ? (
                        <p>
                          {t('Bought asset summary', {
                            value: roundCrypto(transaction.toValue),
                            symbol: transaction.symbol.toUpperCase(),
                            date: moment(transaction.date).format('DD.MM.YYYY'),
                            fiat: `${roundFiat(transaction.fromValue)} EUR`,
                          })}
                        </p>
                      ) : (
                        <p>
                          {t('Selled asset summary', {
                            value: roundCrypto(transaction.fromValue),
                            symbol: transaction.symbol.toUpperCase(),
                            date: moment(transaction.date).format('DD.MM.YYYY'),
                            fiat: `${roundFiat(transaction.toValue)} EUR`,
                            days: transaction.daysFromPurchase,
                            gains: `${roundFiat(transaction.gain)} EUR`,
                          })}
                        </p>
                      )}
                    </Timeline.Item>
                  ))}
                </Timeline>
              )}
            </Panel>
          );
        })}
      </Collapse>
    </>
  );*/
  return <div></div>;
};

export default GainSummary;
