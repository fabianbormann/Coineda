import React from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';

const useStyles = createUseStyles({
  page: {
    padding: 16,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  headline: {
    marginTop: 0,
    marginBottom: 12,
    fontWeight: 500,
    fontSize: '1.1rem',
    color: '#2F4858',
  },
});

const Issues = () => {
  const { t } = useTranslation();
  const classes = useStyles();

  return (
    <div className={classes.page}>
      <p className={classes.headline}>{t('Issues') as string}</p>
      <div>No issues detected</div>
    </div>
  );
};

export default Issues;
