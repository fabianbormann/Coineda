import React, { useState } from 'react';
import { createUseStyles } from 'react-jss';

const useStyles = createUseStyles({
  floatLabel: {
    position: 'relative',
    marginBottom: 12,
  },

  label: {
    fontSize: 12,
    fontWeight: 'normal',
    position: 'absolute',
    pointerEvents: 'none',
    left: 12,
    top: 12,
    transition: '0.2s ease all',
  },

  labelFloat: {
    top: 6,
    fontSize: 10,
  },
});

const FloatingLabel = (props) => {
  const [focus, setFocus] = useState(false);
  const { children, label, value } = props;
  const classes = useStyles();

  const labelClass =
    focus || (value && value.length !== 0)
      ? `${classes.label} ${classes.labelFloat}`
      : classes.label;

  return (
    <div
      className={classes.floatLabel}
      onBlur={() => setFocus(false)}
      onFocus={() => setFocus(true)}
    >
      {children}
      <label className={labelClass}>{label}</label>
    </div>
  );
};

export default FloatingLabel;
