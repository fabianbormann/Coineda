import {
  Accordion,
  AccordionSummary,
  Grid,
  LinearProgress,
  Typography,
  useTheme,
} from '@mui/material';
import React, { SyntheticEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GainSummaryProps } from '../global/types';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Timeline from '@mui/lab/Timeline';
import TimelineItem, { timelineItemClasses } from '@mui/lab/TimelineItem';
import TimelineSeparator from '@mui/lab/TimelineSeparator';
import TimelineConnector from '@mui/lab/TimelineConnector';
import TimelineContent from '@mui/lab/TimelineContent';
import TimelineDot, { timelineDotClasses } from '@mui/lab/TimelineDot';
import dayjs from 'dayjs';

const GainSummary = (props: GainSummaryProps) => {
  const [expanded, setExpanded] = useState<string | false>(false);
  const theme = useTheme();

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
    <Grid sx={{ pt: 1, pb: 1 }}>
      {title && <Typography>{title}</Typography>}
      <Grid sx={{ mt: 2, mb: 2 }}>
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
              key={key}
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
                    <Typography>{`${roundCrypto(amount)} ${gains[
                      coin
                    ][0].symbol.toUpperCase()}`}</Typography>
                    <Typography sx={{ ml: 1 }}>{`${roundFiat(
                      gain
                    )} EUR`}</Typography>
                  </div>
                </span>
              </AccordionSummary>
              {showUnrealizedGains ? (
                <Timeline
                  sx={{
                    [`& .${timelineItemClasses.root}:before`]: {
                      flex: 0,
                      padding: 0,
                    },
                    [`& .${timelineDotClasses.root}`]: {
                      margin: '4px 0',
                      background: theme.palette.primary.main,
                    },
                  }}
                >
                  {gains[coin].map((transaction, key) =>
                    transaction.value > 0 ? (
                      <TimelineItem key={key}>
                        <TimelineSeparator>
                          <TimelineDot />
                          {key < gains[coin].length - 1 && (
                            <TimelineConnector />
                          )}
                        </TimelineSeparator>
                        <TimelineContent
                          sx={{
                            pt:
                              Math.max(0, 366 - transaction.daysFromPurchase) >
                              0
                                ? 0.5
                                : 0,
                          }}
                        >
                          {Math.max(0, 366 - transaction.daysFromPurchase) >
                          0 ? (
                            <>
                              <LinearProgress
                                sx={{ pb: 1 }}
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
                            </>
                          ) : (
                            <Typography>
                              {roundFiat(transaction.gain) > 0
                                ? t(
                                    'You can sell the asset tax free with a total gain of',
                                    {
                                      gain: roundFiat(transaction.gain),
                                      currency: 'EUR',
                                    }
                                  )
                                : t(
                                    'You can sell the asset tax free with a total loss of',
                                    {
                                      gain: roundFiat(transaction.gain),
                                      currency: 'EUR',
                                    }
                                  )}
                            </Typography>
                          )}
                        </TimelineContent>
                      </TimelineItem>
                    ) : null
                  )}
                </Timeline>
              ) : (
                <Timeline
                  sx={{
                    [`& .${timelineItemClasses.root}:before`]: {
                      flex: 0,
                      padding: 0,
                    },
                    [`& .${timelineDotClasses.root}`]: {
                      margin: '4px 0',
                      background: theme.palette.primary.main,
                    },
                  }}
                >
                  {gains[coin].map((transaction, key) => (
                    <TimelineItem
                      key={key}
                      color={transaction.type === 'buy' ? '#03A678' : '#C36491'}
                    >
                      <TimelineSeparator>
                        <TimelineDot />
                        {key < gains[coin].length - 1 && <TimelineConnector />}
                      </TimelineSeparator>
                      <TimelineContent sx={{ pt: 0 }}>
                        {transaction.type === 'buy' ? (
                          <Typography>
                            {t('Bought asset summary', {
                              value: roundCrypto(transaction.toValue),
                              symbol: transaction.symbol.toUpperCase(),
                              date: dayjs(transaction.date).format(
                                'DD.MM.YYYY'
                              ),
                              fiat: `${roundFiat(transaction.fromValue)} EUR`,
                            })}
                          </Typography>
                        ) : (
                          <Typography>
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
                          </Typography>
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
    </Grid>
  );
};

export default GainSummary;
