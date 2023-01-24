import ExchangeManger from '../components/ExchangeManager';
import React, { useEffect, useState, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import moment from 'moment';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { Dayjs } from 'dayjs';
import { createTransaction } from '../helper/common';
import { TextField } from '@mui/material';

const BasicDatePicker = (props: { label: string }) => {
  const [value, setValue] = useState<Dayjs | null>(null);

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <DatePicker
        label={props.label}
        value={value}
        onChange={(newValue) => {
          setValue(newValue);
        }}
        renderInput={(params) => <TextField {...params} />}
      />
    </LocalizationProvider>
  );
};

const AddTransactionsDialog = () => {
  const [selectedExchange, setSelectedExchange] = useState(null);
  const [feeCurrency, setFeeCurrency] = useState('bitcoin');
  const [toCurrency, setToCurrency] = useState('bitcoin');
  const [fromCurrency, setFromCurrency] = useState('euro');
  const [updateKey, setUpdateKey] = useState();
  const { settings } = useContext(SettingsContext);
  const [assets, setAssets] = useState([]);
  const { t } = useTranslation();

  const layout = {
    labelCol: { span: 6 },
    wrapperCol: { span: 18 },
    labelAlign: 'left',
  };

  const defaults = {
    from: 0,
    to: 0,
    fee: 0,
    date: moment(),
  };

  const { account } = settings;

  //const { overrides, visible, onClose } = props;
  const closeDialog = () => {
    setFeeCurrency('bitcoin');
    setToCurrency('bitcoin');
    setFromCurrency('euro');
    setSelectedExchange(null);
    //onClose();
  };
  /*
  useEffect(() => {
    storage.assets.getAll().then((currencies) => {
      setAssets(currencies);
    });
  }, []);

  useEffect(() => {
    if (typeof overrides !== 'undefined') {
      setFeeCurrency(overrides.feeCurrency);
      setToCurrency(overrides.toCurrency);
      setFromCurrency(overrides.fromCurrency);
      setSelectedExchange(overrides.exchange);
      setUpdateKey(overrides.key);
    }
  }, [overrides, form]);

  const decimalValidator = () => ({
    validator(_, value) {
      const reg = /^\d*((\.|,)\d*)?$/;
      if (reg.test(value) || value === '' || value === '.' || value === ',') {
        return Promise.resolve();
      }
      return Promise.reject(new Error('Use a positive decimal number!'));
    },
  });

  const addTransaction = async (values) => {
    const data = {
      exchange: selectedExchange,
      fromValue: values.from,
      fromCurrency: fromCurrency,
      toValue: values.to,
      toCurrency: toCurrency,
      feeValue: values.fee,
      feeCurrency: feeCurrency,
      date: values.date,
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

    createTransaction(data, account.id, message)
      .catch((error) => {
        message.error('Failed to add transaction');
        console.warn(error);
      })
      .finally(() => {
        closeDialog();
      });
  };

  const filterSearch = (input, option) =>
    input.length <= option.key.length &&
    option.key.substring(0, input.length).toLocaleLowerCase() ===
      input.toLocaleLowerCase();

  const sortSearch = (optionA, optionB) =>
    optionA.key.toLowerCase().localeCompare(optionB.key.toLowerCase());

  return (

<Dialog
        fullWidth={fullWidth}
        maxWidth={maxWidth}
        open={visible}
        onClose={closeDialog}
      >
        <DialogTitle>{t('Add Transaction')}</DialogTitle>
        <DialogContent>

          <ExchangeManger
            onExchangeSelected={(exchange) => setSelectedExchange(exchange)}
          />
          <Box
            noValidate
            component="form"
            sx={{
              display: 'flex',
              flexDirection: 'column',
              m: 'auto',
              width: 'fit-content',
            }}
          >
            <BasicDatePicker label={t('Date')} />
            <FormControl>
              <TextField
                id="origin"
                select
                label={t('From')
                sx={{ minWidth: 80 }}
                filterOption={filterSearch}
                filterSort={sortSearch}
                onChange={(symbol) => setFromCurrency(symbol)}
                value={fromCurrency}
                SelectProps={{
                  native: true,
                }}
                helperText="Please select your currency"
              >
                {assets.map((currency) => (
                  <option key={currency.symbol} value={currency.id}>
                    {currency.symbol}
                  </option>
                ))}
              </TextField>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => form.submit()}>Done</Button>
          <Button onClick={handleClose}>Cancel</Button>
        </DialogActions>
      </Dialog>

        
        <Item name="to" label={t('To')} rules={[decimalValidator]}>
          <Input
            addonAfter={
              <Select
                showSearch
                filterOption={filterSearch}
                filterSort={sortSearch}
                style={{ minWidth: 80 }}
                value={toCurrency}
                onChange={(symbol) => setToCurrency(symbol)}
              >
                {assets.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol}
                  </Option>
                ))}
              </Select>
            }
          />
        </Item>
        <Item name="fee" label={t('Fee')} rules={[decimalValidator]}>
          <Input
            addonAfter={
              <Select
                showSearch
                style={{ minWidth: 80 }}
                value={feeCurrency}
                filterOption={filterSearch}
                filterSort={sortSearch}
                onChange={(symbol) => setFeeCurrency(symbol)}
              >
                {assets.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol}
                  </Option>
                ))}
              </Select>
            }
          />
        </Item>
    </Dialog>
  );*/

  return <div></div>;
};

export default AddTransactionsDialog;
