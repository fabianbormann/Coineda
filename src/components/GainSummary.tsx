import {
  Accordion,
  AccordionSummary,
  Grid,
  LinearProgress,
  Typography,
} from '@mui/material';
import React, { SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GainSummaryProps } from '../global/types';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Timeline from '@mui/lab/Timeline';
import TimelineItem from '@mui/lab/TimelineItem';
import TimelineSeparator from '@mui/lab/TimelineSeparator';
import TimelineConnector from '@mui/lab/TimelineConnector';
import TimelineContent from '@mui/lab/TimelineContent';
import TimelineDot from '@mui/lab/TimelineDot';
import dayjs from 'dayjs';

const GainSummary = (props: GainSummaryProps) => {
  const [expanded, setExpanded] = useState<string | false>(false);

  const { gains, showUnrealizedGains } = props;
  const { t } = useTranslation();

  let title = t('Realized Gains');
  if (showUnrealizedGains) {
    title = t('Unrealized Gains');
  }

  if (typeof gains === 'undefined' || Object.keys(gains).length === 0) {
    return null;
  }

  const roundFiat = (value: number) => Math.round(value * 100) / 100;
  const roundCrypto = (value: number) => Math.round(value * 100000) / 100000;

  const handleChange =
    (panel: string) => (event: SyntheticEvent, isExpanded: boolean) => {
      setExpanded(isExpanded ? panel : false);
    };

  return (
    <>
      {title && <Typography>{title}</Typography>}
      <Grid>
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
            <Accordion
              expanded={expanded === `panel-${coin}`}
              onChange={handleChange(`panel-${coin}`)}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-controls="panel1bh-content"
                id="panel1bh-header"
              >
                <span>
                  <div style={{ display: 'flex' }}>
                    <span>{`${roundCrypto(amount)} ${gains[
                      coin
                    ][0].symbol.toUpperCase()}`}</span>
                    <span style={{ flexGrow: 1 }}></span>
                    <span>{`${roundFiat(gain)} EUR`}</span>
                  </div>
                </span>
              </AccordionSummary>
              {showUnrealizedGains ? (
                <Timeline>
                  {gains[coin].map((transaction, key) =>
                    transaction.value > 0 ? (
                      <TimelineItem key={key}>
                        <TimelineSeparator>
                          <TimelineDot />
                          <TimelineConnector />
                        </TimelineSeparator>
                        <TimelineContent>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(
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
                        </TimelineContent>
                      </TimelineItem>
                    ) : null
                  )}
                </Timeline>
              ) : (
                <Timeline>
                  {gains[coin].map((transaction, key) => (
                    <TimelineItem
                      key={key}
                      color={transaction.type === 'buy' ? '#03A678' : '#C36491'}
                    >
                      <TimelineSeparator>
                        <TimelineDot />
                        <TimelineConnector />
                      </TimelineSeparator>
                      <TimelineContent>
                        {transaction.type === 'buy' ? (
                          <p>
                            {t('Bought asset summary', {
                              value: roundCrypto(transaction.toValue),
                              symbol: transaction.symbol.toUpperCase(),
                              date: dayjs(transaction.date).format(
                                'DD.MM.YYYY'
                              ),
                              fiat: `${roundFiat(transaction.fromValue)} EUR`,
                            })}
                          </p>
                        ) : (
                          <p>
                            {t('Selled asset summary', {
                              value: roundCrypto(transaction.fromValue),
                              symbol: transaction.symbol.toUpperCase(),
                              date: dayjs(transaction.date).format(
                                'DD.MM.YYYY'
                              ),
                              fiat: `${roundFiat(transaction.toValue)} EUR`,
                              days: transaction.daysFromPurchase,
                              gains: `${roundFiat(transaction.gain)} EUR`,
                            })}
                          </p>
                        )}
                      </TimelineContent>
                    </TimelineItem>
                  ))}
                </Timeline>
              )}
            </Accordion>
          );
        })}
      </Grid>
    </>
  );
};

export default GainSummary;
