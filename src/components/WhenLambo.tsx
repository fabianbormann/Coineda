import { Grid, LinearProgress, Paper, Typography } from '@mui/material';
import React from 'react';
import { WhenLamboProps } from '../global/types';

const WhenLambo = (props: WhenLamboProps) => {
  const goal = 219000;
  const percent = Math.min(Math.round((props.value / goal) * 10000) / 100, 100);

  return (
    <Paper sx={{ p: 2 }}>
      <Grid container>
        <Grid item xs={12}>
          <Typography>When Lambo?</Typography>
        </Grid>
        <Grid item xs={12} container alignItems="center">
          <LinearProgress
            sx={{ flexGrow: 1, mr: 1 }}
            variant="determinate"
            value={percent}
          />
          <Typography variant="body2" sx={{ p: 1 }}>{`${percent}%`}</Typography>
          <img style={{ maxWidth: 100 }} src={'assets/lamborghini.svg'} />
        </Grid>
      </Grid>
    </Paper>
  );
};

export default WhenLambo;
