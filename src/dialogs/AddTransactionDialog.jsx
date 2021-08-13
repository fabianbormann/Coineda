import { Modal, Form, Select, Divider, Input, message, DatePicker } from 'antd';
import ExchangeManger from '../components/ExchangeManager';
import assets from '../settings/assets.json';
import { createUseStyles } from 'react-jss';
import { useEffect, useState } from 'react';
import axios from 'axios';
import moment from 'moment';

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
  const [form] = Form.useForm();

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

  const submitTransaction = (values) => {
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

    if (typeof updateKey === 'undefined') {
      axios
        .post('http://localhost:5208/transaction', data)
        .catch((error) => {
          message.error('Failed to add transaction');
          console.warn(error);
        })
        .finally(() => {
          closeDialog();
        });
    } else {
      data.updateKey = updateKey;
      axios
        .put('http://localhost:5208/transaction', data)
        .catch((error) => {
          message.error('Failed to update transaction');
          console.warn(error);
        })
        .finally(() => {
          closeDialog();
        });
    }
  };

  const filterSearch = (input, option) =>
    input.length <= option.key.length &&
    option.key.substring(0, input.length).toLocaleLowerCase() ===
      input.toLocaleLowerCase();

  const sortSearch = (optionA, optionB) =>
    optionA.key.toLowerCase().localeCompare(optionB.key.toLowerCase());

  return (
    <Modal
      title="Add Transaction"
      visible={visible}
      okText="Done"
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
        onFinish={submitTransaction}
        form={form}
      >
        <Item name="date" label="Date">
          <DatePicker showTime format="YYYY-MM-DD HH:mm:ss" />
        </Item>
        <Item name="from" label="From" rules={[decimalValidator]}>
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
                {[...assets.fiat, ...assets.cryptocurrencies].map(
                  (currency) => (
                    <Option key={currency.symbol} value={currency.id}>
                      {currency.symbol.toUpperCase()}
                    </Option>
                  )
                )}
              </Select>
            }
          />
        </Item>
        <Item name="to" label="To" rules={[decimalValidator]}>
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
                {[...assets.fiat, ...assets.cryptocurrencies].map(
                  (currency) => (
                    <Option key={currency.symbol} value={currency.id}>
                      {currency.symbol.toUpperCase()}
                    </Option>
                  )
                )}
              </Select>
            }
          />
        </Item>
        <Item name="fee" label="Fee" rules={[decimalValidator]}>
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
                {[...assets.fiat, ...assets.cryptocurrencies].map(
                  (currency) => (
                    <Option key={currency.symbol} value={currency.id}>
                      {currency.symbol.toUpperCase()}
                    </Option>
                  )
                )}
              </Select>
            }
          />
        </Item>
      </Form>
    </Modal>
  );
};

export default AddTransactionsDialog;
