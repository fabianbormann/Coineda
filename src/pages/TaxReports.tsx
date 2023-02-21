import { useTranslation } from 'react-i18next';
import { useState, useContext, useEffect, useMemo } from 'react';
import { SettingsContext } from '../SettingsContext';
import GainSummary from '../components/GainSummary';
import React from 'react';
import { CoinedaAccount, MessageType, TaxResult } from '../global/types';
import {
  Alert,
  AlertTitle,
  Button,
  CircularProgress,
  Divider,
  Grid,
  MenuItem,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import DownloadIcon from '@mui/icons-material/Download';
import dayjs, { Dayjs } from 'dayjs';
import GermanTaxCalculator from '../tax/calculator/GermanTaxCalculator';
import TaxCalculator from '../tax/TaxCalculator';

const TaxReports = () => {
  const { t } = useTranslation();
  const { settings } = useContext(SettingsContext);
  const [selectedYear, setSelectedYear] = useState<Dayjs>(dayjs());
  const [loading, setLoading] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const taxCalculators: Array<TaxCalculator> = useMemo(
    () => [new GermanTaxCalculator()],
    []
  );
  const [calculator, setCalculator] = useState(taxCalculators[0]);
  const [taxResult, setTaxResult] = useState<TaxResult | null>(null);
  const { account } = settings;

  useEffect(() => {
    const calculateTax = async (account: CoinedaAccount, year: number) => {
      setLoading(true);
      try {
        const result = await calculator.calculate(account, year);
        console.log(result);
        setTaxResult(result);
      } catch (error) {
        console.log(error);
        setSnackbarType('error');
        setSnackbarMessage(
          'Tax calculation failed. Please restart the application.'
        );
        setSnackbarOpen(true);
      } finally {
        setLoading(false);
      }
    };
    calculateTax(account, selectedYear.year());
  }, [account, calculator, selectedYear]);

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
    <Grid sx={{ p: 2 }}>
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
          <Grid container sx={{ flexDirection: 'column' }}>
            <Grid item sx={{ mb: 2, mt: 1 }}>
              <TextField
                select
                label={t('Tax Calculator')}
                value={t(calculator?.name) || ''}
                onChange={(event) => {
                  const taxCalculator = taxCalculators.find(
                    (taxCalculator) => taxCalculator.name === event.target.value
                  );
                  if (taxCalculator) {
                    setCalculator(taxCalculator);
                  }
                }}
              >
                {taxCalculators.map((taxCalculator) => (
                  <MenuItem key={taxCalculator.name} value={taxCalculator.name}>
                    {t(taxCalculator.label)}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item>
              <LocalizationProvider dateAdapter={AdapterDayjs}>
                <DatePicker
                  label={t('Tax Year')}
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
            </Grid>
          </Grid>
        </>
      )}

      {taxResult &&
      (Object.keys(taxResult.realizedGains).length > 0 ||
        Object.keys(taxResult.unrealizedGains).length > 0) ? (
        <Grid sx={{ mt: 1, mb: 1 }}>
          <p>{t('Taxable gains and losses')}</p>
          <span
            style={
              taxResult.hasLoss ? { color: '#C36491' } : { color: '#03A678' }
            }
          >{`${taxResult.hasLoss ? '-' : '+'}${Math.abs(
            taxResult.totalGain
          )} EUR`}</span>

          <Alert
            severity={taxResult.isBelowLimit ? 'success' : 'warning'}
            sx={{ mb: 1, mt: 1, maxWidth: 600 }}
          >
            <span>
              {t('You need to pay', {
                approx: taxResult.isBelowLimit ? ' ' : ` ${t('approx')} `,
              })}
              <span>
                {taxResult.isBelowLimit ? '' : '~'} {taxResult.tax} €
              </span>
              {t('Tax this year', { year: selectedYear.year() })}
            </span>
          </Alert>

          <Button
            variant="contained"
            sx={{ mt: 1, mb: 2 }}
            disabled={true}
            startIcon={<DownloadIcon />}
          >
            {t('Download Report')}
          </Button>
          <Divider />
          <GainSummary
            showUnrealizedGains={false}
            gains={taxResult.realizedGains}
          />
          <Divider />
          <GainSummary
            showUnrealizedGains={true}
            gains={taxResult.unrealizedGains}
          />
        </Grid>
      ) : (
        !loading && (
          <Typography sx={{ mt: 1 }}>
            {t('No Transactions in ' + selectedYear.year())}
          </Typography>
        )
      )}
    </Grid>
  );
};

export default TaxReports;
