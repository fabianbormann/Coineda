import { message, Select, Button, Space, Input } from 'antd';
import { PlusCircleOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { createUseStyles } from 'react-jss';
import { useTranslation } from 'react-i18next';

const useStyles = createUseStyles({
  grow: {
    width: '100%',
    paddingBottom: 6,
  },
  input: {
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  wrapper: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    '& > span': {
      minWidth: 40,
    },
  },
});

const { Option } = Select;

const ExchangeManger = (props) => {
  const [exchanges, setExchanges] = useState([]);
  const [newExchangeName, setNewExchangeName] = useState(undefined);
  const [selectedExchange, setSelectedExchange] = useState(undefined);
  const [inputVisible, setInputVisible] = useState(false);
  const classes = useStyles();
  const { t } = useTranslation();

  const { onExchangeSelected } = props;

  const fetchExchanges = useCallback(() => {
    axios
      .get('http://localhost:5208/exchange')
      .then((response) => {
        setExchanges(response.data);
        if (response.data.length > 0) {
          setSelectedExchange({
            value: response.data[0].id,
            label: response.data[0].name,
          });
        }
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      });
  }, []);

  useEffect(() => {
    fetchExchanges();
  }, [fetchExchanges]);

  useEffect(() => {
    if (typeof selectedExchange !== 'undefined') {
      onExchangeSelected(selectedExchange.label);
    }
  }, [selectedExchange, onExchangeSelected]);

  const addExchange = () => {
    axios
      .post('http://localhost:5208/exchange', { name: newExchangeName })
      .then(() => fetchExchanges())
      .catch((error) => {
        message.error('Failed to add exchange/wallet');
        console.warn(error);
      })
      .finally(() => {
        setNewExchangeName(undefined);
        setInputVisible(false);
      });
  };

  const label = props.label ? <span>{props.label}:</span> : null;

  return (
    <Space direction="vertical" className={classes.grow}>
      {exchanges.length > 0 && (
        <div className={classes.wrapper}>
          {label}
          <Select
            labelInValue
            placeholder={t('Select an exchange or a wallet')}
            value={selectedExchange}
            className={classes.grow}
            onChange={(option) => {
              props.onExchangeSelected(option.label);
              setSelectedExchange(option);
            }}
          >
            {exchanges.map((exchange) => (
              <Option key={exchange.id} value={exchange.id}>
                {exchange.name}
              </Option>
            ))}
          </Select>
        </div>
      )}
      {inputVisible ? (
        <div className={classes.wrapper}>
          <Input
            className={classes.input}
            value={newExchangeName}
            onChange={(event) => setNewExchangeName(event.target.value)}
            placeholder="Exchange/Wallet name"
            suffix={
              <Button type="primary" onClick={addExchange}>
                Add
              </Button>
            }
          />
        </div>
      ) : props.showAddExchangeButton ? (
        <Button
          onClick={() => setInputVisible(true)}
          type="primary"
          shape="round"
          icon={<PlusCircleOutlined />}
        >
          {t('Add new exchange or wallet')}
        </Button>
      ) : null}
    </Space>
  );
};

ExchangeManger.defaultProps = {
  onExchangeSelected: () => {
    console.warn('onExchangeSelected not implemented yet.');
  },
  showAddExchangeButton: true,
};

export default ExchangeManger;
