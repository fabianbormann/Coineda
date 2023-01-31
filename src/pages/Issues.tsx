import { Grid, Typography } from '@mui/material';
import React from 'react';
import GppGoodIcon from '@mui/icons-material/GppGood';

const Issues = () => {
  return (
    <Grid container direction="column" sx={{ p: 2, alignItems: 'center' }}>
      <GppGoodIcon sx={{ mt: 2, fontSize: 40 }} />
      <Typography sx={{ mt: 1 }}>No issues detected</Typography>
    </Grid>
  );
};

export default Issues;
