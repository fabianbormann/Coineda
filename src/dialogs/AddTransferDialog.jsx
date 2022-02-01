import {
  Modal,
  Form,
  Select,
  Divider,
  Input,
  message,
  DatePicker,
  Alert,
} from 'antd';
import ExchangeManger from '../components/ExchangeManager';
import { createUseStyles } from 'react-jss';
import { useEffect, useState, useContext } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import moment from 'moment';
import { SettingsContext } from '../SettingsContext';

const { Item } = Form;
const { Option } = Select;

const useStyles = createUseStyles({
  section: {
    width: '80%',
    padding: 2,
  },
});

const AddTransferDialog = (props) => {
  const [fromExchange, setFromExchange] = useState(null);
  const [toExchange, setToExchange] = useState(null);
  const [feeCurrency, setFeeCurrency] = useState('bitcoin');
  const [currency, setCurrency] = useState('bitcoin');
  const [settings] = useContext(SettingsContext);
  const [assets, setAssets] = useState([]);
  const [updateKey, setUpdateKey] = useState();
  const [form] = Form.useForm();
  const { t } = useTranslation();

  const { account } = settings;

  const layout = {
    labelCol: { span: 6 },
    wrapperCol: { span: 18 },
    labelAlign: 'left',
  };

  const defaults = {
    value: 0,
    fee: 0,
    date: moment(),
  };

  const { visible, onClose, overrides } = props;
  const closeDialog = () => {
    setFeeCurrency('bitcoin');
    setCurrency('bitcoin');
    setFromExchange(null);
    setToExchange(null);
    form.setFieldsValue({
      value: 0,
      fee: 0,
      date: moment(),
    });
    onClose();
  };

  useEffect(() => {
    if (typeof overrides !== 'undefined') {
      setFeeCurrency(overrides.feeCurrency);
      setCurrency(overrides.valueCurrency);
      form.setFieldsValue({
        value: overrides.value,
        fee: overrides.feeValue,
        date: moment(overrides.date),
      });
      setFromExchange(overrides.fromExchange);
      setToExchange(overrides.toExchange);
      setUpdateKey(overrides.id);
    }
  }, [overrides, form]);

  useEffect(() => {
    axios
      .get('http://localhost:5208/assets/sorted')
      .then((response) => {
        setAssets(response.data);
      })
      .catch((error) => {
        message.error('Failed to fetch assets');
        console.warn(error);
      });
  }, []);

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
      fromExchange: fromExchange,
      toExchange: toExchange,
      value: values.value,
      currency: currency,
      feeValue: values.fee,
      feeCurrency: feeCurrency,
      date: values.date,
      account: account.id,
    };

    if (typeof updateKey === 'undefined') {
      axios
        .post('http://localhost:5208/transfers', data)
        .catch((error) => {
          message.error('Failed to add transfer');
          console.warn(error);
        })
        .finally(() => {
          closeDialog();
        });
    } else {
      data.id = updateKey;
      axios
        .put('http://localhost:5208/transfers', data)
        .catch((error) => {
          message.error('Failed to update transfer');
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
      title={t('Add Transfer')}
      visible={visible}
      okText={t('Done')}
      okButtonProps={{
        disabled: fromExchange === null || toExchange === null,
      }}
      onOk={() => form.submit()}
      onCancel={closeDialog}
    >
      <div className={classes.section}>
        <ExchangeManger
          showAddExchangeButton={false}
          label={t('From')}
          onExchangeSelected={(exchange) => setFromExchange(exchange)}
        />
      </div>
      <div className={classes.section}>
        <ExchangeManger
          label={t('To')}
          defaultSelectionIndex={1}
          onExchangeSelected={(exchange) => setToExchange(exchange)}
        />
      </div>
      {fromExchange === toExchange && toExchange !== null && (
        <Alert
          message={t('Please select different exchanges')}
          type="warning"
          showIcon
        />
      )}
      <Divider />
      <Form
        {...layout}
        initialValues={defaults}
        className={classes.section}
        onFinish={submitTransaction}
        form={form}
      >
        <Item name="value" label={t('Currency')} rules={[decimalValidator]}>
          <Input
            addonAfter={
              <Select
                showSearch
                style={{ minWidth: 80 }}
                value={currency}
                filterOption={filterSearch}
                filterSort={sortSearch}
                onChange={(symbol) => setCurrency(symbol)}
              >
                {assets.map((currency) => (
                  <Option key={currency.symbol} value={currency.id}>
                    {currency.symbol.toUpperCase()}
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
                    {currency.symbol.toUpperCase()}
                  </Option>
                ))}
              </Select>
            }
          />
        </Item>
        <Item name="date" label={t('Date')}>
          <DatePicker showTime format="YYYY-MM-DD HH:mm:ss" />
        </Item>
      </Form>
    </Modal>
  );
};

export default AddTransferDialog;
