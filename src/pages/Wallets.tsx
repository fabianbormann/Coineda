import React from 'react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import storage from '../persistence/storage';
import {
  Alert,
  Button,
  Divider,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Popover,
  Snackbar,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Exchange, MessageType } from '../global/types';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';

const Wallets = () => {
  const { t } = useTranslation();
  const [selectedExchange, setSelectedExchange] = useState<Exchange | null>(
    null
  );
  const [walletType, setWalletType] = useState<string>();
  const [exchanges, setExchanges] = useState<Array<Exchange>>([]);
  const [walletName, setWalletName] = useState('');
  const [walletAddress, setWalletAddress] = useState(
    '0x0000000000000000000000000000000000000000'
  );
  const [apiKey, setApiKey] = useState('');
  const [anchorElement, setAnchorElement] = useState<HTMLButtonElement | null>(
    null
  );
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');

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
        setSnackbarType('error');
        setSnackbarMessage(
          'Coineda backend is not available. Please restart the application.'
        );
        setSnackbarOpen(true);
        console.warn(error);
      });
  }, []);

  useEffect(() => {
    fetchExchanges();
  }, [fetchExchanges]);

  const saveWallet = async () => {
    if (selectedExchange) {
      try {
        await storage.exchanges
          .put({
            id: selectedExchange.id,
            walletType: walletType,
            apiKey: apiKey,
            publicAddress: walletAddress,
            automaticImport: false,
            name: walletName,
          })
          .then(() => {
            setSnackbarType('success');
            setSnackbarMessage('Wallet successfully updated');
            setSnackbarOpen(true);
          });
      } catch (error) {
        setSnackbarType('error');
        setSnackbarMessage('Failed to save wallet information.');
        setSnackbarOpen(true);
        console.warn(error);
      }
    }
  };

  const deleteWallet = async () => {
    if (selectedExchange) {
      try {
        await storage.exchanges.delete(selectedExchange.id).then(() => {
          fetchExchanges();
        });
      } catch (error) {
        setSnackbarType('error');
        setSnackbarMessage('Failed to delete the wallet.');
        setSnackbarOpen(true);
        console.warn(error);
      }
    }
  };

  const ethereumWalletContent = (
    <>
      <Divider />
      <Typography>{t('API Settings')}</Typography>
      <TextField
        label={t('Public Address')}
        value={walletAddress}
        onChange={(event) => setWalletAddress(event.target.value)}
      />
      <a href="https://docs.etherscan.io/getting-started/viewing-api-usage-statistics">
        How to get an Etherscan API key?
      </a>
      <TextField label={t('Etherscan API key')} value={''} />
      <Tooltip title={t('Automatic imports will be supported near future.')}>
        <FormControl>
          <InputLabel htmlFor="automatic-import-binance">
            "Automatic import enabled"
          </InputLabel>
          <Switch id="automatic-import-binance" disabled />
        </FormControl>
      </Tooltip>
    </>
  );

  const binanceWalletContent = (
    <>
      <Divider />
      <Typography>{t('API Settings')}</Typography>
      <Alert severity="warning">
        {t('Automatic imports will be supported near future.')}
      </Alert>
      <a href="https://www.binance.com/en/support/faq/360002502072">
        How to create an Binance API key?
      </a>

      <TextField
        label={t('Binance API key')}
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />

      <Tooltip title={t('Automatic imports will be supported near future.')}>
        <FormControl>
          <InputLabel htmlFor="automatic-import-binance">
            "Automatic import enabled"
          </InputLabel>
          <Switch id="automatic-import-binance" disabled />
        </FormControl>
      </Tooltip>
    </>
  );

  const showPopconfirm = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorElement(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorElement(null);
  };

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
      <Typography variant="h6" sx={{ mb: 1 }}>
        {t('Wallets')}
      </Typography>
      <Grid container direction="column">
        <TextField
          select
          label={t('Select an exchange or a wallet')}
          value={selectedExchange?.id || ''}
          disabled={exchanges.length === 0}
          sx={{ mt: 1, mb: 1 }}
          onChange={(event) => {
            const exchange = exchanges.find(
              (exchange) => exchange.id === Number(event.target.value)
            );

            if (exchange) {
              setSelectedExchange(exchange);
            }
          }}
        >
          {exchanges.map((exchange) => (
            <MenuItem key={exchange.id} value={exchange.id}>
              {exchange.name}
            </MenuItem>
          ))}
        </TextField>
        <Divider sx={{ mt: 1, mb: 1 }} />
        <Grid container direction="column">
          <TextField
            label={t('Wallet Name')}
            value={walletName}
            onChange={(event) => setWalletName(event.target.value)}
            sx={{ mt: 1, mb: 1 }}
          />
          <TextField
            value={walletType}
            label={t('Wallet Type')}
            sx={{ mt: 1, mb: 1 }}
            onChange={(event) => {
              setWalletType(event.target.value);
            }}
          >
            <MenuItem value="binance">Binance Exchange Wallet</MenuItem>
            <MenuItem value="kraken">Kraken Exchange Wallet</MenuItem>
            <MenuItem value="uphold">Uphold Exchange Wallet</MenuItem>
            <MenuItem value="ethereum">{t('Ethereum Wallet')}</MenuItem>
            <MenuItem value="other">{t('Other')}</MenuItem>
          </TextField>
          {walletType === 'ethereum' && ethereumWalletContent}
          {walletType === 'binance' && binanceWalletContent}
          <Divider sx={{ mt: 1, mb: 1 }} />
          <Grid>
            <Button
              variant="contained"
              onClick={saveWallet}
              sx={{ ml: 1, mr: 1 }}
              startIcon={<SaveIcon />}
            >
              {t('Save')}
            </Button>

            <Button
              variant="contained"
              onClick={showPopconfirm}
              sx={{ ml: 1, mr: 1 }}
              startIcon={<DeleteIcon />}
            >
              {t('Delete')}
            </Button>

            <Popover
              open={Boolean(anchorElement)}
              anchorEl={anchorElement}
              onClose={handleClose}
            >
              <Typography sx={{ p: 2 }}>
                Are you sure to delete this wallet?
              </Typography>
              <Button onClick={deleteWallet}>{t('Yes')}</Button>
              <Button onClick={handleClose}>{t('No')}</Button>
            </Popover>
          </Grid>
        </Grid>
      </Grid>
    </Grid>
  );
};

export default Wallets;
