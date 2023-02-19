import React, { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import storage from '../persistence/storage';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Grid,
  Link,
  MenuItem,
  Popover,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import { Exchange, MessageType } from '../global/types';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import BinanceApiSync from '../import/source/BinanceApiSync';
import { ApiSyncSource } from '../import/ApiSyncSource';
import { ExchangeManager } from '../components';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';

const Wallets = () => {
  const { t } = useTranslation();
  const [selectedExchange, setSelectedExchange] = useState<Exchange | null>(
    null
  );
  const [defaultSelectionIndex, setDefaultSelectionIndex] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [refreshExchanges, setRefreshExchanges] = useState(0);
  const mandatoryFieldRefs = useRef<{ [key: string]: HTMLInputElement | null }>(
    {}
  );
  const [walletType, setWalletType] = useState('');
  const [exchanges, setExchanges] = useState<Array<Exchange>>([]);
  const [walletName, setWalletName] = useState('');
  const [anchorElement, setAnchorElement] = useState<HTMLButtonElement | null>(
    null
  );
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const availableApiSources: Array<ApiSyncSource> = useMemo(
    () => [new BinanceApiSync()],
    []
  );

  const fetchExchanges = useCallback(() => {
    storage.exchanges
      .getAll()
      .then((response) => {
        setExchanges(response);
      })
      .catch((error) => {
        setSnackbarType('error');
        setSnackbarMessage(
          t(
            'Unable to fetch exchanges from database. Please try again or contact the support'
          ) as string
        );
        setSnackbarOpen(true);
        console.warn(error);
      });
  }, [t]);

  useEffect(() => {
    fetchExchanges();
  }, [fetchExchanges]);

  useEffect(() => {
    if (selectedExchange) {
      setWalletName(selectedExchange.name);
      setWalletType(selectedExchange.type || 'other');
      const exchangeSyncSource = availableApiSources.find(
        (availableApiSource) =>
          availableApiSource.name === selectedExchange.type
      );
      if (exchangeSyncSource) {
        for (const mandatoryField of exchangeSyncSource.getMandatoryFields()) {
          const mandatoryFieldRef =
            mandatoryFieldRefs.current[mandatoryField.name];
          if (mandatoryFieldRef) {
            mandatoryFieldRef.value =
              localStorage.getItem(
                `${selectedExchange.id}-${selectedExchange.name}-${mandatoryField.name}`
              ) || '';
          }
        }
      }
    }
  }, [selectedExchange, availableApiSources]);

  const saveWallet = async () => {
    if (selectedExchange) {
      try {
        await storage.exchanges.put({
          id: selectedExchange.id,
          type: walletType,
          name: walletName,
        });

        const exchangeSyncSource = availableApiSources.find(
          (availableApiSource) =>
            availableApiSource.name === selectedExchange.type
        );
        if (exchangeSyncSource) {
          for (const mandatoryField of exchangeSyncSource.getMandatoryFields()) {
            const mandatoryFieldRef =
              mandatoryFieldRefs.current[mandatoryField.name];
            if (mandatoryFieldRef) {
              localStorage.setItem(
                `${selectedExchange.id}-${walletName}-${mandatoryField.name}`,
                mandatoryFieldRef.value || ''
              );

              localStorage.removeItem(
                `${selectedExchange.id}-${selectedExchange.name}-${mandatoryField.name}`
              );
            }
          }
        }

        setSnackbarType('success');
        setSnackbarMessage(t('Wallet successfully updated') as string);
        setSnackbarOpen(true);
        fetchExchanges();
        setDefaultSelectionIndex(
          exchanges.findIndex(
            (exchange) => exchange.name === selectedExchange.name
          ) || 0
        );
        setRefreshExchanges((value) => 1 - value);
      } catch (error) {
        setSnackbarType('error');
        setSnackbarMessage(t('Failed to save wallet information.') as string);
        setSnackbarOpen(true);
        console.warn(error);
      }
    }
  };

  const deleteWallet = async () => {
    if (selectedExchange) {
      try {
        await storage.exchanges.delete(selectedExchange.id);

        const exchangeSyncSource = availableApiSources.find(
          (availableApiSource) =>
            availableApiSource.name === selectedExchange.type
        );
        if (exchangeSyncSource) {
          for (const mandatoryField of exchangeSyncSource.getMandatoryFields()) {
            const mandatoryFieldRef =
              mandatoryFieldRefs.current[mandatoryField.name];
            if (mandatoryFieldRef) {
              localStorage.removeItem(
                `${selectedExchange.id}-${selectedExchange.name}-${mandatoryField.name}`
              );
            }
          }
        }

        fetchExchanges();
      } catch (error) {
        setSnackbarType('error');
        setSnackbarMessage(t('Failed to delete the wallet') as string);
        setSnackbarOpen(true);
        console.warn(error);
      }
    }
  };

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

  const renderImportSource = () => {
    const importSource = availableApiSources.find(
      (availableApiSource) => availableApiSource.name === walletType
    );
    if (importSource) {
      return (
        <Grid sx={{ mt: 1 }}>
          {importSource.getMandatoryFields().map((mandatoryField) => (
            <TextField
              InputLabelProps={{ shrink: true }}
              key={mandatoryField.name}
              defaultValue={
                localStorage.getItem(
                  `${selectedExchange?.id}-${selectedExchange?.name}-${mandatoryField.name}`
                ) || ''
              }
              placeholder={t(mandatoryField.description) as string}
              label={t(mandatoryField.label)}
              inputRef={(element: HTMLInputElement) =>
                (mandatoryFieldRefs.current[mandatoryField.name] = element)
              }
              sx={{ mr: 1, mb: 1 }}
            />
          ))}
          <Grid
            container
            sx={{
              flexDirection: 'column',
            }}
          >
            <Box sx={{ m: 1, position: 'relative', width: 'fit-content' }}>
              <Button
                startIcon={!syncing && <CloudDownloadIcon />}
                variant="contained"
                color="secondary"
                disabled={syncing || importSource.name === 'BinanceApiSync'}
                onClick={async () => {
                  setSyncing(true);
                  try {
                    const config = importSource
                      .getMandatoryFields()
                      .map((mandatoryField) => mandatoryField.name)
                      .reduce(
                        (prev, fieldName) => ({
                          ...prev,
                          [fieldName]: localStorage.getItem(
                            `${selectedExchange?.id}-${selectedExchange?.name}-${fieldName}`
                          ),
                        }),
                        {}
                      );

                    await importSource.fetch(config);
                  } catch (error) {
                    console.warn(error);
                  } finally {
                    setSyncing(false);
                  }
                }}
                sx={{ mt: 1, mb: 1 }}
              >
                <Typography
                  variant="body2"
                  sx={{ visibility: syncing ? 'hidden' : 'visible' }}
                >
                  {t('Start Syncing')}
                </Typography>
              </Button>
              {syncing && (
                <CircularProgress
                  size={24}
                  sx={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    marginTop: '-12px',
                    marginLeft: '-12px',
                  }}
                />
              )}
            </Box>
            {importSource.name === 'BinanceApiSync' && (
              <Alert severity="warning">
                {t(
                  'The Binance API does currently not allow client side requests.'
                )}
                <Link
                  target="_blank"
                  rel="noreferrer"
                  href="https://github.com/fabianbormann/Coineda/issues/76"
                >
                  {t('We are planning to provide a workaround in the future.')}
                </Link>
              </Alert>
            )}
          </Grid>
          {importSource.hasDescription && (
            <>
              <Typography variant="h5" sx={{ mt: 1, mb: 1 }}>
                {t(importSource.descriptionTitle || '') as string}
              </Typography>
              {importSource.getDescription(t)}
            </>
          )}
        </Grid>
      );
    }
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
        <ExchangeManager
          defaultSelectionIndex={defaultSelectionIndex}
          refreshExchanges={refreshExchanges}
          onExchangeSelected={(exchangeName) => {
            if (exchangeName === selectedExchange?.name) {
              return;
            }

            const exchange = exchanges.find(
              (exchange) => exchange.name === exchangeName
            );

            if (exchange) {
              setSelectedExchange(exchange);
            }
          }}
        />
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
            select
            onChange={(event) => {
              setWalletType(event.target.value);
            }}
          >
            {availableApiSources.map((availableImportSource: ApiSyncSource) => (
              <MenuItem
                key={availableImportSource.name}
                value={availableImportSource.name}
              >
                {availableImportSource.label}
              </MenuItem>
            ))}
            <MenuItem value="other">{t('Other')}</MenuItem>
          </TextField>
          {walletType !== 'other' && renderImportSource()}
          <Divider sx={{ mt: 1, mb: 2 }} />
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
