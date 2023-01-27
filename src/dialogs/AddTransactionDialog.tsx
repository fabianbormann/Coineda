import ExchangeManger from '../components/ExchangeManager';
import React, { useEffect, useState, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import dayjs, { Dayjs } from 'dayjs';
import { createTransaction } from '../helper/common';
import {
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  TextField,
} from '@mui/material';
import { Token, TransactionDialogProps } from '../global/types';

const AddTransactionsDialog = (props: TransactionDialogProps) => {
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null);
  const [fromExchange, setFromExchange] = useState<string | null>(null);
  const [toExchange, setToExchange] = useState<string | null>(null);
  const [feeValue, setFeeValue] = useState('0.0');
  const [toValue, setToValue] = useState('0.0');
  const [fromValue, setFromValue] = useState('0.0');
  const [feeCurrency, setFeeCurrency] = useState('EUR');
  const [toCurrency, setToCurrency] = useState('BTC');
  const [fromCurrency, setFromCurrency] = useState('EUR');
  const [isTransfer, setIsTransfer] = useState(false);
  const [date, setDate] = useState<Dayjs | null>();
  const [updateKey, setUpdateKey] = useState<number>();
  const [refreshExchanges, setRefreshExchanges] = useState(0);
  const { settings } = useContext(SettingsContext);
  const [assets, setAssets] = useState([]);
  const { t } = useTranslation();
  const { account } = settings;
  const { overrides, visible, onClose } = props;
  const closeDialog = () => {
    setFeeCurrency('bitcoin');
    setToCurrency('bitcoin');
    setFromCurrency('euro');
    setSelectedExchange(null);
    onClose();
  };

  useEffect(() => {
    storage.assets.getAll().then((currencies) => {
      setAssets(currencies);
    });
  }, []);

  useEffect(() => {
    if (typeof overrides !== 'undefined') {
      if (overrides.type === 'transfer') {
        setFromExchange(overrides.fromExchange);
        setToExchange(overrides.toExchange);
      } else {
        setSelectedExchange(overrides.exchange);
        setToValue(overrides.toValue.toString());
        setToCurrency(overrides.toCurrency);
      }

      setFeeValue(overrides.feeValue.toString());
      setFeeCurrency(overrides.feeCurrency);
      setFromValue(overrides.fromValue.toString());
      setFromCurrency(overrides.fromCurrency);
      setDate(dayjs(overrides.date));
      setFromCurrency(overrides.fromCurrency);
      setSelectedExchange(overrides.exchange);
      setUpdateKey(overrides.key);
    }
  }, [overrides]);

  const addTransaction = async () => {
    if (isTransfer) {
      const data = {
        fromExchange: fromExchange,
        toExchange: toExchange,
        value: fromValue,
        currency: fromCurrency,
        feeValue: feeValue,
        feeCurrency: feeCurrency,
        date: date,
        account: account.id,
      };

      if (typeof updateKey !== 'undefined') {
        await storage.transfers.delete(updateKey);
      }

      try {
        await storage.transfers.add(data);
      } catch (error) {
        console.warn(error);
      } finally {
        closeDialog();
      }
    } else {
      const data = {
        exchange: selectedExchange,
        fromValue: fromValue,
        fromCurrency: fromCurrency,
        toValue: toValue,
        toCurrency: toCurrency,
        feeValue: feeValue,
        feeCurrency: feeCurrency,
        date: date,
        account: account.id,
      };

      if (typeof updateKey !== 'undefined') {
        const transaction = await storage.transactions.get(updateKey);
        if (transaction.isComposed) {
          const children = transaction.composedKeys.split(',');
          for (const child of children) {
            storage.transactions.delete(child);
          }
        }
        storage.transactions.delete(updateKey);
      }

      try {
        await createTransaction(data, account.id);
      } catch (error) {
        console.warn(error);
      } finally {
        closeDialog();
      }
    }
  };

  const validate = (value: string) =>
    !(
      /^\d*((\.|,)\d*)?$/.test(value) ||
      value === '' ||
      value === '.' ||
      value === ','
    );

  return (
    <Dialog open={visible} onClose={closeDialog}>
      <DialogTitle>{t('Add Transaction')}</DialogTitle>
      <DialogContent>
        <FormControlLabel
          control={
            <Switch
              value={isTransfer}
              onChange={(event) => setIsTransfer(event.target.checked)}
            />
          }
          label="Transfer"
        />
        {isTransfer ? (
          <>
            <ExchangeManger
              showAddExchangeButton={false}
              label={t('From') as string}
              refreshExchanges={refreshExchanges}
              forceRefreshExchanges={() =>
                setRefreshExchanges(1 - refreshExchanges)
              }
              defaultSelectionIndex={0}
              onExchangeSelected={(exchange) => setFromExchange(exchange)}
            />
            <ExchangeManger
              label={t('To') as string}
              refreshExchanges={refreshExchanges}
              forceRefreshExchanges={() =>
                setRefreshExchanges(1 - refreshExchanges)
              }
              defaultSelectionIndex={1}
              onExchangeSelected={(exchange) => setToExchange(exchange)}
            />
          </>
        ) : (
          <ExchangeManger
            onExchangeSelected={(exchange) => setSelectedExchange(exchange)}
          />
        )}
        <Box
          noValidate
          component="form"
          sx={{
            p: 2,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <DateTimePicker
              label={t('Date')}
              value={date}
              onChange={(newValue) => {
                setDate(newValue);
              }}
              renderInput={(params) => <TextField {...params} />}
            />
          </LocalizationProvider>

          <TextField
            label={isTransfer ? t('Currency') : t('From')}
            value={fromValue}
            error={validate(fromValue)}
            helperText={validate(fromValue) && 'Please enter a valid number'}
            onChange={(event) => setFromValue(event.target.value)}
            sx={{ minWidth: 80, mt: 2 }}
            InputProps={{
              endAdornment: (
                <Autocomplete
                  value={fromCurrency}
                  disablePortal
                  disableClearable
                  options={assets.map((asset: Token) => asset.symbol)}
                  onChange={(event, value) => setFromCurrency(value || 'euro')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      sx={{ pl: 1, pr: 1 }}
                      variant="standard"
                    />
                  )}
                />
              ),
            }}
          />

          {!isTransfer && (
            <TextField
              label={t('To')}
              value={toValue}
              error={validate(toValue)}
              helperText={validate(toValue) && 'Please enter a valid number'}
              onChange={(event) => setToValue(event.target.value)}
              sx={{ minWidth: 80, mt: 2 }}
              InputProps={{
                endAdornment: (
                  <Autocomplete
                    value={toCurrency}
                    disablePortal
                    disableClearable
                    options={assets.map((asset: Token) => asset.symbol)}
                    onChange={(event, value) => setToCurrency(value || 'euro')}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        sx={{ pl: 1, pr: 1 }}
                        variant="standard"
                      />
                    )}
                  />
                ),
              }}
            />
          )}

          <TextField
            label={t('Fee')}
            value={feeValue}
            error={validate(feeValue)}
            helperText={validate(feeValue) && 'Please enter a valid number'}
            onChange={(event) => setFeeValue(event.target.value)}
            sx={{ minWidth: 80, mt: 2 }}
            InputProps={{
              endAdornment: (
                <Autocomplete
                  value={feeCurrency}
                  disablePortal
                  disableClearable
                  options={assets.map((asset: Token) => asset.symbol)}
                  onChange={(event, value) => setFeeCurrency(value || 'euro')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      sx={{ pl: 1, pr: 1 }}
                      variant="standard"
                    />
                  )}
                />
              ),
            }}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={() => addTransaction()}>Done</Button>
      </DialogActions>
    </Dialog>
  );
};

export default AddTransactionsDialog;
