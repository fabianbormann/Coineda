import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import storage from '../persistence/storage';
import React from 'react';

const Wallets = () => {
  const { t } = useTranslation();
  const [selectedExchange, setSelectedExchange] = useState(undefined);
  const [walletType, setWalletType] = useState();
  const [exchanges, setExchanges] = useState([]);
  const [walletName, setWalletName] = useState('');
  const [walletAddress, setWalletAddress] = useState(
    '0x0000000000000000000000000000000000000000'
  );
  const [apiKey, setApiKey] = useState('');

  const fetchExchanges = useCallback(() => {
    storage.exchanges
      .getAll()
      .then((response) => {
        setExchanges(response);
        if (response.length > 0) {
          setSelectedExchange({
            ...response[0],
            value: response[0].id,
            label: response[0].name,
          });
          setWalletName(response[0].name);
          setWalletType(response[0].walletType);
        }
      })
      .catch((error) => {
        /*message.error(
          'Coineda backend is not available. Please restart the application.'
        );*/
        console.warn(error);
      });
  }, []);

  useEffect(() => {
    fetchExchanges();
  }, [fetchExchanges]);

  /*const saveWallet = async () => {
    try {
      await storage.exchanges
        .put({
          id: selectedExchange.value,
          walletType: walletType,
          apiKey: apiKey,
          publicAddress: walletAddress,
          automaticImport: false,
          name: walletName,
        })
        .then(() => {
          message.success('Wallet successfully updated');
        });
    } catch (error) {
      message.error('Failed to save wallet information.');
      console.warn(error);
    }
  };

  const deleteWallet = async () => {
    try {
      await storage.exchanges.delete(selectedExchange.value).then(() => {
        fetchExchanges();
      });
    } catch (error) {
      message.error('Failed to delete the wallet');
      console.warn(error);
    }
  };

  const ethereumWalletContent = (
    <>
      <Divider />
      <p className={classes.headline}>{t('API Settings')}</p>
      <FloatingLabel label={t('Public Address')} value={walletAddress}>
        <Input
          value={walletAddress}
          onChange={(event) => setWalletAddress(event.target.value)}
        />
      </FloatingLabel>
      <a href="https://docs.etherscan.io/getting-started/viewing-api-usage-statistics">
        How to get an Etherscan API key?
      </a>
      <FloatingLabel label={t('Etherscan API key')} value={''}>
        <Input />
      </FloatingLabel>
      <label>Automatic import enabled</label>
      <Switch disabled />
    </>
  );

  const binanceWalletContent = (
    <>
      <Divider />
      <p className={classes.headline}>{t('API Settings')}</p>
      <Alert
        message={t('Automatic imports will be supported near future.')}
        type="warning"
      />
      <a href="https://www.binance.com/en/support/faq/360002502072">
        How to create an Binance API key?
      </a>

      <FloatingLabel label={t('Binance API key')} value={apiKey}>
        <Input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </FloatingLabel>

      <label>Automatic import enabled</label>
      <Tooltip
        placement="top"
        title={t('Automatic imports will be supported near future.')}
      >
        <Switch disabled />
      </Tooltip>
    </>
  );

  return (
    <div className={classes.page}>
      <p className={classes.headline}>{t('Wallets')}</p>
      <div className={classes.form}>
        <Select
          labelInValue
          placeholder={t('Select an exchange or a wallet')}
          value={selectedExchange}
          disabled={exchanges.length === 0}
          className={classes.select}
          onChange={(option) => {
            setSelectedExchange(option);
            setWalletName(option.label);
            setWalletType(option.walletType);
          }}
        >
          {exchanges.map((exchange) => (
            <Option key={exchange.id} value={exchange.id}>
              {exchange.name}
            </Option>
          ))}
        </Select>
        <Divider />
        <Space direction="vertical">
          <FloatingLabel label={t('Wallet Name')} value={walletName}>
            <Input
              value={walletName}
              onChange={(event) => setWalletName(event.target.value)}
            />
          </FloatingLabel>
          <Select
            value={walletType}
            placeholder={t('Wallet Type')}
            onChange={(option) => {
              setWalletType(option);
            }}
            className={classes.select}
          >
            <Option value="binance">Binance Exchange Wallet</Option>
            <Option value="kraken">Kraken Exchange Wallet</Option>
            <Option value="uphold">Uphold Exchange Wallet</Option>
            <Option value="ethereum">{t('Ethereum Wallet')}</Option>
            <Option value="other">{t('Other')}</Option>
          </Select>
          {walletType === 'ethereum' && ethereumWalletContent}
          {walletType === 'binance' && binanceWalletContent}
          <Divider />
          <Space>
            <Button onClick={saveWallet} icon={<SaveOutlined />} type="primary">
              {t('Save')}
            </Button>
            <Popconfirm
              title="Are you sure to delete this wallet?"
              onConfirm={deleteWallet}
              okText="Yes"
              cancelText="No"
            >
              <Button icon={<DeleteOutlined />}>{t('Delete')}</Button>
            </Popconfirm>
          </Space>
        </Space>
      </div>
    </div>*/
  return <div></div>;
};

export default Wallets;
