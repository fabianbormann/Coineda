import React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Exchange, ExchangeManagerProps } from '../global/types';
import storage from '../persistence/storage';
import { Button, Grid, MenuItem, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

const ExchangeManger = ({
  onExchangeSelected,
  showAddExchangeButton = true,
  defaultSelectionIndex = 0,
  forceRefreshExchanges = () => {},
  refreshExchanges = 0,
  label,
}: ExchangeManagerProps) => {
  const [exchanges, setExchanges] = useState<Array<Exchange>>([]);
  const [newExchangeName, setNewExchangeName] = useState<string>();
  const [selectedExchange, setSelectedExchange] = useState<Exchange | null>(
    null
  );
  const [inputVisible, setInputVisible] = useState(false);
  const { t } = useTranslation();

  const fetchExchanges = useCallback((defaultSelectionIndex: number) => {
    storage.exchanges
      .getAll()
      .then((results) => {
        setExchanges(results);
        if (results.length > defaultSelectionIndex) {
          setSelectedExchange(results[defaultSelectionIndex]);
        } else if (results.length > 0) {
          setSelectedExchange(results[0]);
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
      onExchangeSelected(selectedExchange?.name || null);
    }
  }, [selectedExchange, onExchangeSelected]);

  const addExchange = () => {
    storage.exchanges
      .add({ name: newExchangeName })
      .then(() => {
        forceRefreshExchanges();
        fetchExchanges(defaultSelectionIndex);
      })
      .catch((error) => {
        console.warn(error);
      })
      .finally(() => {
        setNewExchangeName(undefined);
        setInputVisible(false);
      });
  };

  return (
    <Grid container direction="column" sx={{ p: 2 }}>
      <TextField
        select
        InputLabelProps={{ shrink: true }}
        variant="standard"
        label={label || t('Select an exchange or a wallet')}
        value={selectedExchange?.name || ''}
        disabled={exchanges.length === 0}
        onChange={(event) => {
          onExchangeSelected(event.target.value);
          setSelectedExchange(
            exchanges.find(
              (exchange) => exchange.name === event.target.value
            ) || null
          );
        }}
      >
        {exchanges.map((exchange) => (
          <MenuItem key={exchange.id} value={exchange.name}>
            {exchange.name}
          </MenuItem>
        ))}
      </TextField>

      {inputVisible ? (
        <TextField
          value={newExchangeName}
          sx={{ mt: 2 }}
          onChange={(event) => setNewExchangeName(event.target.value)}
          placeholder="Exchange/Wallet name"
          InputProps={{
            endAdornment: (
              <Button variant="contained" onClick={addExchange}>
                Add
              </Button>
            ),
          }}
        />
      ) : showAddExchangeButton ? (
        <Button onClick={() => setInputVisible(true)} startIcon={<AddIcon />}>
          {t('Add new exchange or wallet')}
        </Button>
      ) : null}
    </Grid>
  );
};

export default ExchangeManger;
