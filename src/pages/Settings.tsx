import { Grid, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { useTranslation } from 'react-i18next';
import AccountManagement from '../components/AccountManagement';
import AssetManagement from '../components/AssetManagement';

const Settings = () => {
  const { t, i18n } = useTranslation();

  const changeLanguage = (
    event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>
  ) => {
    i18n.changeLanguage(event.target.value);
  };

  let { language } = i18n;
  language = language.split('-')[0];

  return (
    <Grid sx={{ p: 2 }}>
      <Typography variant="h6">{t('General') as string}</Typography>

      <TextField
        sx={{ mt: 2, mb: 2, minWidth: 200 }}
        label={t('Language') as string}
        select
        variant="standard"
        onChange={changeLanguage}
        value={language}
      >
        <MenuItem value="de">Deutsch</MenuItem>
        <MenuItem value="en">English</MenuItem>
      </TextField>
      <AccountManagement />
      <AssetManagement />
    </Grid>
  );
};

export default Settings;
