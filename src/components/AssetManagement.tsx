import React, { useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import storage from '../persistence/storage';
import {
  CoinGekoCoinList,
  MessageType,
  Token,
  TokenCache,
} from '../global/types';
import {
  Alert,
  Button,
  Grid,
  IconButton,
  InputAdornment,
  MenuItem,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';

const AssetManagement = () => {
  const { t } = useTranslation();
  const [searchResults, setSearchResults] = useState<CoinGekoCoinList>([]);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [searchText, setSearchText] = useState('');
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');

  const onSearch = async (value: string) => {
    if (value.length > 1) {
      const tokenCacheString = localStorage.getItem('TOKEN_LIST');
      let tokenCache: TokenCache | null = null;
      if (tokenCacheString) {
        tokenCache = JSON.parse(tokenCacheString);
      }

      let results: CoinGekoCoinList = [];
      if (
        tokenCache &&
        new Date().getTime() - tokenCache.age < 1000 * 60 * 15
      ) {
        results = tokenCache.entries.filter(
          (token: Token) => token.symbol.toLowerCase() === value.toLowerCase()
        );
      } else {
        try {
          const tokenList: CoinGekoCoinList = (
            await axios.get('https://api.coingecko.com/api/v3/coins/list')
          ).data;

          localStorage.setItem(
            'TOKEN_LIST',
            JSON.stringify({
              entries: tokenList,
              age: new Date().getTime(),
            })
          );
          results = tokenList.filter(
            (token) => token.symbol.toLowerCase() === value.toLowerCase()
          );
        } catch (error) {
          console.log(error);
        }
      }

      setSearchResults(results);
      if (results.length > 0) {
        setSelectedAsset(results[0].id);
      } else {
        setSelectedAsset('');
        setSnackbarMessage(
          `Could not fetch any token or coin having the symbol ${value}`
        );
        setSnackbarType('warning');
        setSnackbarOpen(true);
      }
      setSearchText('');
    }
  };

  const selectAsset = (
    event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>
  ) => {
    setSelectedAsset(event.target.value);
  };

  const addAsset = async () => {
    const asset = searchResults.find((result) => result.id === selectedAsset);
    if (asset) {
      try {
        const existingAsset = await storage.assets.get(asset.id);
        if (existingAsset) {
          setSnackbarMessage(
            t(
              `${asset.name} (${asset.symbol}) has already been added to your asset list`
            ) as string
          );

          setSnackbarType('info');
          setSnackbarOpen(true);
        } else {
          await storage.assets.add(asset);
          setSnackbarMessage(
            t(
              `Successfully added ${asset.name} (${asset.symbol}) to your asset list`
            ) as string
          );
          setSnackbarType('info');
          setSnackbarOpen(true);
        }
      } catch (error) {
        setSnackbarMessage(
          t(
            'Asset persistence failed. Please restart the application.'
          ) as string
        );
        setSnackbarType('error');
        setSnackbarOpen(true);
        console.warn(error);
      } finally {
        setSearchText('');
        setSelectedAsset('');
        setSearchResults([]);
      }
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

  return (
    <div>
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
      <Typography sx={{ mt: 2 }} variant="h6">
        {t('Asset Management')}
      </Typography>
      <Typography sx={{ mt: 1, mb: 2, maxWidth: 600 }}>
        {t('Asset Explanation')}
      </Typography>
      <TextField
        placeholder={t('Asset input placeholder') as string}
        label="Search field"
        type="search"
        value={searchText}
        onKeyDown={(event) => {
          if (event.code === '13') {
            onSearch(searchText);
          }
        }}
        onChange={(event) => setSearchText(event.target.value)}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => onSearch(searchText)} edge="end">
                <SearchIcon />
              </IconButton>
            </InputAdornment>
          ),
        }}
      />
      {searchResults.length > 0 && (
        <Grid container sx={{ mt: 2, maxWidth: 300 }}>
          <TextField
            sx={{ flexGrow: 1 }}
            select
            variant="standard"
            value={selectedAsset}
            onChange={selectAsset}
            placeholder="Select a token"
          >
            {searchResults.map((result) => (
              <MenuItem
                key={result.id}
                value={result.id}
              >{`${result.name} (${result.symbol})`}</MenuItem>
            ))}
          </TextField>
          <Button
            sx={{ ml: 2 }}
            variant="contained"
            startIcon={<AddIcon />}
            onClick={addAsset}
          >
            {t('Add')}
          </Button>
        </Grid>
      )}
    </div>
  );
};

export default AssetManagement;
