import { useTranslation } from 'react-i18next';
import { Divider, Empty, message, Spin, DatePicker, Button, Alert } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import { useState, useContext, useCallback, useEffect } from 'react';
import { SettingsContext } from '../SettingsContext';
import moment from 'moment';
import GainSummary from '../components/GainSummary';
import { calculateTax } from '../helper/tax';

const useStyles = createUseStyles({
  actions: {
    marginTop: 0,
    marginBottom: 12,
  },
  divider: {
    marginTop: 12,
    marginBottom: 12,
  },
  negative: {
    color: '#C36491',
  },
  positive: {
    color: '#03A678',
  },
  page: {
    padding: 16,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  summary: {
    marginBottom: 12,
    fontFamily: 'PTSerif',
    fontWeight: 600,
    fontSize: '1.2rem',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
  },
  headline: {
    margin: 0,
    fontWeight: 500,
    fontSize: '1.1rem',
    color: '#2F4858',
  },
});

const TaxReports = () => {
  const { t } = useTranslation();
  const classes = useStyles();
  const [settings] = useContext(SettingsContext);
  const [summary, setSummary] = useState({
    realizedGains: {},
    unrealizedGains: {},
  });
  const [selectedYear, setSelectedYear] = useState(new Date());
  const [loading, setLoading] = useState(false);

  const { account } = settings;

  const fetchSummary = useCallback(() => {
    setLoading(true);
    calculateTax(account.id)
      .then((tax) => {
        setSummary(tax);
      })
      .catch((error) => {
        message.error(
          'Tax calculation failed. Please restart the application.'
        );
        console.warn(error);
      })
      .finally(() => setLoading(false));
  }, [account]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const roundFiat = (value) => Math.round(value * 100) / 100;

  const realizedWithinTaxYear = {};
  for (const coin of Object.keys(summary.realizedGains)) {
    realizedWithinTaxYear[coin] = summary.realizedGains[coin].filter(
      (transaction) =>
        new Date(transaction.date) >
          new Date(selectedYear.getFullYear(), 0, 1) &&
        new Date(transaction.date) <
          new Date(selectedYear.getFullYear(), 11, 31)
    );
  }

  const unrealizedAfterTaxYear = {};
  for (const coin of Object.keys(summary.unrealizedGains)) {
    unrealizedAfterTaxYear[coin] = summary.unrealizedGains[coin].filter(
      (transaction) =>
        new Date(new Date(transaction.date).getFullYear(), 0, 1) <=
        new Date(selectedYear.getFullYear(), 0, 1)
    );
  }

  let totalGain = 0;
  for (const coin of Object.keys(realizedWithinTaxYear)) {
    totalGain += realizedWithinTaxYear[coin].reduce(
      (previous, current) => previous + current.gain,
      0
    );
  }

  const hasLoss = totalGain < 0;
  const isBelowLimit = totalGain < 600;
  const tax = isBelowLimit ? 0 : totalGain * 0.5;

  let disclaimerVisible =
    localStorage.getItem('coineda.show.discalimer') || true;

  if (disclaimerVisible === 'false') {
    disclaimerVisible = false;
  }

  return (
    <div className={classes.page}>
      {loading ? (
        <div className={classes.loading}>
          <Spin />
        </div>
      ) : (
        <>
          {' '}
          {disclaimerVisible && (
            <Alert
              message="Disclaimer"
              showIcon
              description="Coineda does not provide tax, legal or accounting advices. The provided dashboard and rudimentary tax calculations may contain errors, are incorrect for your country or doesn't cover all tax relevant regulations. Those calculations are developed to the best of my knowledge but I'm not a tax export and I do not take any responsibility for incorrect calculations."
              type="warning"
              closeText="Got it"
              onClose={() => {
                localStorage.setItem('coineda.show.discalimer', false);
              }}
            />
          )}
          <p className={classes.headline}>{t('Tax Year')}</p>
          <DatePicker
            style={{ maxWidth: 200, marginBottom: 16 }}
            value={moment(selectedYear)}
            onChange={(date, dateString) => {
              setSelectedYear(new Date(dateString));
            }}
            picker="year"
          />
        </>
      )}

      {Object.keys(realizedWithinTaxYear).length > 0 ||
      Object.keys(unrealizedAfterTaxYear).length > 0 ? (
        <div>
          <p className={classes.headline}>{t('Taxable gains and losses')}</p>
          <span
            style={hasLoss ? { color: '#C36491' } : { color: '#03A678' }}
            className={classes.summary}
          >{`${hasLoss ? '-' : '+'}${roundFiat(
            Math.abs(totalGain)
          )} EUR`}</span>

          <Alert
            style={{ marginBottom: 24, marginTop: 16, maxWidth: 600 }}
            message={
              <span>
                {t('You need to pay', {
                  approx: isBelowLimit ? ' ' : ` ${t('approx')} `,
                })}
                <span
                  className={isBelowLimit ? classes.positive : classes.negative}
                >
                  {isBelowLimit ? '' : '~'} {roundFiat(tax)} €
                </span>
                {t('Tax this year', { year: selectedYear.getFullYear() })}
              </span>
            }
            type={isBelowLimit ? 'info' : 'warning'}
            showIcon
          />

          <Button disabled={true} icon={<DownloadOutlined />}>
            {t('Download Report')}
          </Button>
          <Divider className={classes.divider} />
          <GainSummary
            showUnrealizedGains={false}
            gains={realizedWithinTaxYear}
          />
          <GainSummary
            showUnrealizedGains={true}
            gains={unrealizedAfterTaxYear}
          />
        </div>
      ) : (
        !loading && (
          <Empty
            description={t('No Transactions in ' + selectedYear.getFullYear())}
          />
        )
      )}
    </div>
  );
};

export default TaxReports;
