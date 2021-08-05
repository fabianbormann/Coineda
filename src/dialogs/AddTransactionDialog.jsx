import { Modal, Form, Select, Divider, Input, message, DatePicker } from 'antd';
import ExchangeManger from '../components/ExchangeManager';
import assets from '../settings/assets.json';
import { createUseStyles } from 'react-jss';
import { useState } from 'react';
import axios from 'axios';

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
  };

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

    axios
      .post('http://localhost:5208/transaction', data)
      .catch((error) => {
        message.error('Failed to add exchange/wallet');
        console.warn(error);
      })
      .finally(() => {
        props.onClose();
      });
  };

  return (
    <Modal
      title="Add Transaction"
      visible={props.visible}
      okText="Done"
      okButtonProps={{
        disabled: selectedExchange === null,
      }}
      onOk={() => form.submit()}
      onCancel={props.onClose}
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
          <DatePicker showTime format="DD.MM.YYYY HH:mm:ss" />
        </Item>
        <Item name="from" label="From" rules={[decimalValidator]}>
          <Input
            addonAfter={
              <Select
                showSearch
                style={{ minWidth: 80 }}
                value={fromCurrency}
                onChange={(symbol) => setFromCurrency(symbol)}
              >
                {assets.fiat.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
                  </Option>
                ))}
                {assets.cryptocurrencies.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
                  </Option>
                ))}
              </Select>
            }
          />
        </Item>
        <Item name="to" label="To" rules={[decimalValidator]}>
          <Input
            addonAfter={
              <Select
                showSearch
                filterOption={(input, option) =>
                  option.key.toLowerCase().indexOf(input.toLowerCase()) >= 0
                }
                filterSort={(optionA, optionB) =>
                  optionA.key
                    .toLowerCase()
                    .localeCompare(optionB.key.toLowerCase())
                }
                style={{ minWidth: 80 }}
                value={toCurrency}
                onChange={(symbol) => setToCurrency(symbol)}
              >
                {assets.fiat.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
                  </Option>
                ))}
                {assets.cryptocurrencies.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
                  </Option>
                ))}
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
                onChange={(symbol) => setFeeCurrency(symbol)}
              >
                {assets.fiat.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
                  </Option>
                ))}
                {assets.cryptocurrencies.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
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
