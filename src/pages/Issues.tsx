import { Grid, Typography } from '@mui/material';
import React from 'react';
import { useTranslation } from 'react-i18next';
import GppGoodIcon from '@mui/icons-material/GppGood';

const Issues = () => {
  const { t } = useTranslation();

  return (
    <Grid container direction="column" sx={{ alignItems: 'center' }}>
      <GppGoodIcon sx={{ mt: 2, fontSize: 40 }} />
      <Typography sx={{ mt: 1 }}>No issues detected</Typography>
    </Grid>
  );
};

export default Issues;
