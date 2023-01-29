import { useTranslation } from 'react-i18next';
import { useState, useContext, useCallback, useEffect } from 'react';
import { SettingsContext } from '../SettingsContext';
import moment from 'moment';
import GainSummary from '../components/GainSummary';
import { calculateTax } from '../helper/tax';
import React from 'react';
import {
  MessageType,
  TaxSummary,
  TaxTransaction,
  Transaction,
} from '../global/types';
import {
  Alert,
  AlertTitle,
  Button,
  CircularProgress,
  Divider,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import DownloadIcon from '@mui/icons-material/Download';
import dayjs, { Dayjs } from 'dayjs';

const TaxReports = () => {
  const { t } = useTranslation();
  const { settings } = useContext(SettingsContext);
  const [summary, setSummary] = useState<TaxSummary>({
    realizedGains: {},
    unrealizedGains: {},
  });
  const [selectedYear, setSelectedYear] = useState<Dayjs>(dayjs());
  const [loading, setLoading] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');

  const { account } = settings;

  const fetchSummary = useCallback(() => {
    setLoading(true);
    calculateTax(account.id)
      .then((tax) => {
        setSummary(tax);
      })
      .catch((error) => {
        setSnackbarType('error');
        setSnackbarMessage(
          'Tax calculation failed. Please restart the application.'
        );
        setSnackbarOpen(true);
        console.warn(error);
      })
      .finally(() => setLoading(false));
  }, [account]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const roundFiat = (value: number) => Math.round(value * 100) / 100;

  const realizedWithinTaxYear: { [key: string]: Array<TaxTransaction> } = {};
  for (const coin of Object.keys(summary.realizedGains)) {
    realizedWithinTaxYear[coin] = summary.realizedGains[coin].filter(
      (transaction) =>
        new Date(transaction.date) > new Date(selectedYear.year(), 0, 1) &&
        new Date(transaction.date) < new Date(selectedYear.year(), 11, 31)
    );
  }

  const unrealizedAfterTaxYear: { [key: string]: Array<TaxTransaction> } = {};
  for (const coin of Object.keys(summary.unrealizedGains)) {
    unrealizedAfterTaxYear[coin] = summary.unrealizedGains[coin].filter(
      (transaction) =>
        new Date(new Date(transaction.date).getFullYear(), 0, 1) <=
        new Date(selectedYear.year(), 0, 1)
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

  const handleSnackbarClose = (
    event?: React.SyntheticEvent | Event,
    reason?: string
  ) => {
    if (reason === 'clickaway') {
      return;
    }

    setSnackbarOpen(false);
  };

  return (
    <div>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={handleSnackbarClose}
      >
        <Alert
          onClose={handleSnackbarClose}
          severity={snackbarType}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
      {loading ? (
        <div>
          <CircularProgress />
        </div>
      ) : (
        <>
          {' '}
          {disclaimerVisible && (
            <Alert
              action={
                <Button
                  onClick={() => {
                    localStorage.setItem('coineda.show.discalimer', 'false');
                  }}
                >
                  {t('Got it')}
                </Button>
              }
              severity="warning"
            >
              <AlertTitle>{t('Disclaimer')}</AlertTitle>
              {t('Disclaimer Text')}
            </Alert>
          )}
          <Typography>{t('Tax Year')}</Typography>
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <DatePicker
              label={t('Date')}
              views={['year']}
              value={selectedYear}
              onChange={(date) => {
                if (date) {
                  setSelectedYear(date);
                }
              }}
              renderInput={(params) => <TextField {...params} />}
            />
          </LocalizationProvider>
        </>
      )}

      {Object.keys(realizedWithinTaxYear).length > 0 ||
      Object.keys(unrealizedAfterTaxYear).length > 0 ? (
        <div>
          <p>{t('Taxable gains and losses')}</p>
          <span
            style={hasLoss ? { color: '#C36491' } : { color: '#03A678' }}
          >{`${hasLoss ? '-' : '+'}${roundFiat(
            Math.abs(totalGain)
          )} EUR`}</span>

          <Alert
            severity={isBelowLimit ? 'info' : 'warning'}
            sx={{ mb: 24, mt: 16, maxWidth: 600 }}
          >
            <span>
              {t('You need to pay', {
                approx: isBelowLimit ? ' ' : ` ${t('approx')} `,
              })}
              <span>
                {isBelowLimit ? '' : '~'} {roundFiat(tax)} €
              </span>
              {t('Tax this year', { year: selectedYear.year })}
            </span>
          </Alert>

          <Button disabled={true} startIcon={<DownloadIcon />}>
            {t('Download Report')}
          </Button>
          <Divider />
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
          <Typography>
            {t('No Transactions in ' + selectedYear.year)}
          </Typography>
        )
      )}
    </div>
  );
};

export default TaxReports;
