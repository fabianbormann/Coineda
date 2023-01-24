import React, { useState } from 'react';

const FloatingLabel = () => {
  const [focus, setFocus] = useState(false);
  /*const { children, label, value } = props;

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
  );*/

  return <div></div>;
};

export default FloatingLabel;
