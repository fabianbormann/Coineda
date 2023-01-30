import { LinearProgress } from '@mui/material';
import React from 'react';
import { WhenLamboProps } from '../global/types';

const WhenLambo = (props: WhenLamboProps) => {
  const goal = 219000;
  const percent = Math.min(Math.round((props.value / goal) * 10000) / 100, 100);

  return (
    <div>
      <span>When Lambo?</span>
      <div>
        <LinearProgress value={percent} />
        <div />
        <img style={{ maxWidth: 100 }} src={'assets/lamborghini.svg'} />
      </div>
    </div>
  );
};

export default WhenLambo;
