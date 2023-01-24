import React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import storage from '../persistence/storage';

const ExchangeManger = () => {
  const [exchanges, setExchanges] = useState([]);
  const [newExchangeName, setNewExchangeName] = useState(undefined);
  const [selectedExchange, setSelectedExchange] = useState(undefined);
  const [inputVisible, setInputVisible] = useState(false);
  const { t } = useTranslation();
  /*
  const {
    onExchangeSelected,
    defaultSelectionIndex,
    label,
    showAddExchangeButton,
    refreshExchanges,
    forceRefreshExchanges,
  } = props;

  const fetchExchanges = useCallback((defaultSelectionIndex) => {
    storage.exchanges
      .getAll()
      .then((results) => {
        setExchanges(results);
        if (results.length > defaultSelectionIndex) {
          setSelectedExchange({
            value: results[defaultSelectionIndex].id,
            label: results[defaultSelectionIndex].name,
          });
        } else if (results.length > 0) {
          setSelectedExchange({
            value: results[0].id,
            label: results[0].name,
          });
        }
      })
      .catch((error) => {
        console.warn(error);
      });
  }, []);

  useEffect(() => {
    fetchExchanges(defaultSelectionIndex);
  }, [fetchExchanges, defaultSelectionIndex, refreshExchanges]);

  useEffect(() => {
    if (typeof selectedExchange !== 'undefined') {
      onExchangeSelected(selectedExchange.label);
    }
  }, [selectedExchange, onExchangeSelected]);

  const addExchange = () => {
    storage.exchanges
      .add({ name: newExchangeName })
      .then(() => {
        forceRefreshExchanges();
        fetchExchanges();
      })
      .catch((error) => {
        message.error('Failed to add exchange/wallet');
        console.warn(error);
      })
      .finally(() => {
        setNewExchangeName(undefined);
        setInputVisible(false);
      });
  };

  const text = label ? <span>{label}:</span> : null;

  return (
    <Space direction="vertical" className={classes.grow}>
      <div className={classes.wrapper}>
        {text}
        <Select
          labelInValue
          placeholder={t('Select an exchange or a wallet')}
          value={selectedExchange}
          disabled={exchanges.length === 0}
          className={classes.grow}
          onChange={(option) => {
            onExchangeSelected(option.label);
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
      ) : showAddExchangeButton ? (
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
  );*/
  return <div></div>;
};

ExchangeManger.defaultProps = {
  onExchangeSelected: () => {
    console.warn('onExchangeSelected not implemented yet.');
  },
  showAddExchangeButton: true,
  defaultSelectionIndex: 0,
  forceRefreshExchanges: () => {},
  refreshExchanges: 0,
};

export default ExchangeManger;
