import { Modal, Form, Select, Divider, Input, message, DatePicker } from 'antd';
import ExchangeManger from '../components/ExchangeManager';
import { createUseStyles } from 'react-jss';
import { useEffect, useState, useContext } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import moment from 'moment';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';

import { isFiat, TransactionType } from '../helper/common';

const { Item } = Form;
const { Option } = Select;

const useStyles = createUseStyles({
  section: {
    width: '80%',
    padding: 2,
  },
});

const AddTransactionsDialog = (props) => {
  const [selectedExchange, setSelectedExchange] = useState(null);
  const [feeCurrency, setFeeCurrency] = useState('bitcoin');
  const [toCurrency, setToCurrency] = useState('bitcoin');
  const [fromCurrency, setFromCurrency] = useState('euro');
  const [updateKey, setUpdateKey] = useState();
  const [settings] = useContext(SettingsContext);
  const [assets, setAssets] = useState([]);
  const [form] = Form.useForm();
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

  const { overrides, visible, onClose } = props;
  const closeDialog = () => {
    setFeeCurrency('bitcoin');
    setToCurrency('bitcoin');
    setFromCurrency('euro');
    setSelectedExchange(null);
    form.setFieldsValue({
      from: 0,
      to: 0,
      fee: 0,
      date: moment(),
    });
    onClose();
  };

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
      form.setFieldsValue({
        from: overrides.fromValue,
        to: overrides.toValue,
        fee: overrides.feeValue,
        date: moment(overrides.date),
      });
      setSelectedExchange(overrides.exchange);
      setUpdateKey(overrides.key);
    }
  }, [overrides, form]);

  const classes = useStyles();
  const decimalValidator = () => ({
    validator(_, value) {
      const reg = /^\d*((\.|,)\d*)?$/;
      if (reg.test(value) || value === '' || value === '.' || value === ',') {
        return Promise.resolve();
      }
      return Promise.reject(new Error('Use a positive decimal number!'));
    },
  });

  const createTransaction = async (transaction) => {
    let {
      exchange,
      fromValue,
      fromCurrency,
      toValue,
      toCurrency,
      feeValue,
      feeCurrency,
      date,
    } = transaction;

    const fromCurrencyIsFiat = await isFiat(fromCurrency);
    const toCurrencyIsFiat = await isFiat(toCurrency);
    const children = [];
    let isSwap = false;

    let transactionType = TransactionType.BUY;
    if (!fromCurrencyIsFiat && toCurrencyIsFiat) {
      transactionType = TransactionType.SELL;
    } else if (!fromCurrencyIsFiat && !toCurrencyIsFiat) {
      isSwap = true;
      transactionType = TransactionType.SELL;
      let price = 0;
      const toTimestamp = Math.floor(new Date(date).getTime() / 1000);
      const fromTimestamp = Math.floor(
        (new Date(date).getTime() - 1000 * 60 * 60 * 5) / 1000
      );

      try {
        const response = await axios.get(
          `https://api.coingecko.com/api/v3/coins/${fromCurrency.toLowerCase()}/market_chart/range?vs_currency=eur&from=${fromTimestamp}&to=${toTimestamp}`
        );
        price = response.data.prices[0][1];
      } catch (error) {
        console.log(error);
        message.error(
          'Failed to fetch price from CoinGeckoApi. Please try again later.'
        );
        return;
      }

      const sellTransaction = {
        type: transactionType,
        exchange: exchange,
        fromValue: fromValue,
        fromCurrency: fromCurrency.toUpperCase(),
        toValue: price * fromValue,
        toCurrency: 'euro',
        feeValue: feeValue,
        feeCurrency: feeCurrency.toUpperCase(),
        isComposed: false,
        parent: undefined,
        composedKeys: undefined,
        date: date.unix(),
        account: account.id,
      };

      const key = await storage.transactions.add(sellTransaction);
      children.push({
        id: key,
        ...sellTransaction,
      });

      transactionType = TransactionType.BUY;

      fromCurrency = 'euro';
      fromValue = Math.round(price * fromValue * 100) / 100;
    }

    const buyTransaction = {
      type: transactionType,
      exchange: exchange,
      fromValue: fromValue,
      fromCurrency: fromCurrency.toUpperCase(),
      toValue: toValue,
      toCurrency: toCurrency.toUpperCase(),
      feeValue: feeValue,
      feeCurrency: feeCurrency.toUpperCase(),
      isComposed: false,
      parent: undefined,
      composedKeys: undefined,
      date: date.unix(),
      account: account.id,
    };

    const key = await storage.transactions.add(buyTransaction);

    children.push({
      id: key,
      ...buyTransaction,
    });

    if (isSwap) {
      transactionType = TransactionType.SWAP;

      const parent = await storage.transactions.add({
        type: transactionType,
        exchange: exchange,
        fromValue: children[0].fromValue,
        fromCurrency: children[0].fromCurrency,
        toValue: children[1].toValue,
        toCurrency: children[1].toCurrency,
        feeValue: feeValue,
        feeCurrency: feeCurrency.toUpperCase(),
        isComposed: true,
        parent: undefined,
        composedKeys: `${children[0].id},${children[1].id}`,
        date: date.unix(),
        account: account.id,
      });

      for (const child of children) {
        storage.transactions.put({
          ...child,
          parent: parent,
        });
      }
    }
  };

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

    createTransaction(data)
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
    <Modal
      title={t('Add Transaction')}
      visible={visible}
      okText={t('Done')}
      okButtonProps={{
        disabled: selectedExchange === null,
      }}
      onOk={() => form.submit()}
      onCancel={closeDialog}
    >
      <div className={classes.section}>
        <ExchangeManger
          onExchangeSelected={(exchange) => setSelectedExchange(exchange)}
        />
      </div>
      <Divider />
      <Form
        {...layout}
        initialValues={defaults}
        className={classes.section}
        onFinish={addTransaction}
        form={form}
      >
        <Item name="date" label={t('Date')}>
          <DatePicker showTime format="YYYY-MM-DD HH:mm:ss" />
        </Item>
        <Item name="from" label={t('From')} rules={[decimalValidator]}>
          <Input
            addonAfter={
              <Select
                showSearch
                style={{ minWidth: 80 }}
                value={fromCurrency}
                filterOption={filterSearch}
                filterSort={sortSearch}
                onChange={(symbol) => setFromCurrency(symbol)}
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
      </Form>
    </Modal>
  );
};

export default AddTransactionsDialog;
