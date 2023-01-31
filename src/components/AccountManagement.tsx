import { useState, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';
import React from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  IconButton,
  MenuItem,
  Popover,
  Slider,
  Snackbar,
  styled,
  TextField,
  Typography,
} from '@mui/material';
import {
  AccountDialogMode,
  CoinedaAccount,
  MessageType,
} from '../global/types';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';

const Logo = styled('div')(() => ({
  background: 'url("./logo192.png")',
  width: 32,
  height: 32,
  backgroundSize: 'contain',
}));

const AccountManagement = () => {
  const { settings, setSettings } = useContext(SettingsContext);
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Array<CoinedaAccount>>([]);
  const [accountName, setAccountName] = useState('');
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [pattern, setPattern] = useState(Math.random() * 1000);
  const [anchorElement, setAnchorElement] = useState<HTMLButtonElement | null>(
    null
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTitle, setDialogTitle] = useState(t('Add Account'));
  const [dialogMode, setDialogMode] = useState<AccountDialogMode>('add');

  useEffect(() => {
    const fetchAccounts = async () => {
      setAccounts(await storage.accounts.getAll());
    };

    fetchAccounts();
  }, []);

  const submit = async () => {
    if (dialogMode === 'add') {
      try {
        await storage.accounts.add(accountName, pattern);
        const updatedAccounts = await storage.accounts.getAll();
        setAccounts(updatedAccounts);
        setSettings({
          ...settings,
          account: updatedAccounts[updatedAccounts.length - 1],
        });
      } catch (error) {
        setSnackbarMessage(
          'Failed to save the account. Please restart the application.'
        );
        setSnackbarOpen(true);
        setSnackbarType('error');
        console.warn(error);
      } finally {
        setDialogOpen(false);
      }
    } else {
      try {
        await storage.accounts.put({
          id: settings.account.id,
          name: accountName,
          pattern: pattern,
        });
        const updatedAccounts = await storage.accounts.getAll();
        setAccounts(updatedAccounts);
        setSettings({
          ...settings,
          account: updatedAccounts.find(
            (account: CoinedaAccount) => account.id === settings.account.id
          ),
        });
      } catch (error) {
        setSnackbarMessage(
          'Failed to save the account. Please restart the application.'
        );
        setSnackbarOpen(true);
        setSnackbarType('error');
        console.warn(error);
      } finally {
        setDialogOpen(false);
      }
    }
  };

  const addAccount = () => {
    setDialogTitle(t('Add Account'));
    setDialogMode('add');
    setPattern(Math.random() * 1000);
    setAccountName('');
    setDialogOpen(true);
  };

  const editAccount = () => {
    setDialogTitle(t('Edit Account'));
    setDialogMode('edit');
    setPattern(settings.account.pattern);
    setAccountName(settings.account.name);
    setDialogOpen(true);
  };

  const deleteAccount = async () => {
    if (settings.account.id === 1) {
      setSnackbarMessage(
        t(
          'This account is protected by default and cannot be removed'
        ) as string
      );
      setSnackbarOpen(true);
      setSnackbarType('warning');

      return;
    }

    try {
      await storage.accounts.delete(settings.account.id);
      const updatedAccounts = await storage.accounts.getAll();
      setAccounts(updatedAccounts);
      setSettings({
        ...settings,
        account: updatedAccounts[0],
      });
    } catch (error) {
      setSnackbarMessage(
        'Failed to delete the account. Please try again or contact the support.'
      );
      setSnackbarOpen(true);
      setSnackbarType('error');
      console.warn(error);
    }
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

  const showPopconfirm = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorElement(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorElement(null);
  };

  return (
    <>
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

      <Typography variant="h6">{t('Account Management')}</Typography>
      <Grid sx={{ mt: 2 }}>
        <Grid container>
          <TextField
            sx={{ flexGrow: 1 }}
            select
            value={settings.account.name}
            variant="standard"
            onChange={(
              event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>
            ) => {
              const selectedAccount = accounts.find(
                (account) => account.name === event.target.value
              );

              if (selectedAccount) {
                setSettings({
                  ...settings,
                  account: selectedAccount,
                });
                localStorage.setItem('activeAccount', event.target.value);
              }
            }}
          >
            {accounts.map((account) => (
              <MenuItem key={account.name} value={account.name}>
                <Grid container>
                  <Logo sx={{ filter: `hue-rotate(${account.pattern}deg)` }} />
                  <Typography sx={{ ml: 1 }}>{account.name}</Typography>
                </Grid>
              </MenuItem>
            ))}
          </TextField>

          <IconButton onClick={editAccount}>
            <EditIcon />
          </IconButton>

          <IconButton onClick={showPopconfirm}>
            <DeleteIcon />
          </IconButton>
          <Popover
            open={Boolean(anchorElement)}
            anchorEl={anchorElement}
            onClose={handleClose}
          >
            <Typography sx={{ p: 2 }}>
              {t('Are you sure to delete this account?')}
            </Typography>
            <Button onClick={deleteAccount}>Delete</Button>
            <Button onClick={deleteAccount}>Cancel</Button>
          </Popover>
        </Grid>
        <Button sx={{ mt: 2 }} variant="contained" onClick={addAccount}>
          {t('Add Account')}
        </Button>
      </Grid>
      <Dialog open={dialogOpen}>
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogContent sx={{ zIndex: 100 }}>
          <TextField
            autoComplete="off"
            sx={{ mb: 2, mt: 1 }}
            placeholder="Account Name"
            label="Name"
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
          />
          <Grid container direction="row">
            <Grid item xs={12}>
              <Typography>{t('Color:')}</Typography>
            </Grid>
            <Grid item>
              <Logo sx={{ filter: `hue-rotate(${pattern}deg)` }} />
            </Grid>
            <Grid sx={{ ml: 1, mr: 1 }} flexGrow={1}>
              <Slider
                aria-label="Hue rotation for new account"
                value={pattern}
                onChange={(_event, value) => {
                  if (typeof value === 'number') {
                    setPattern(value);
                  }
                }}
                step={1}
                sx={{ ml: 1 }}
                min={0}
                max={360}
                valueLabelDisplay="auto"
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Ok</Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default AccountManagement;
