import { useTranslation } from 'react-i18next';
import { Result } from 'antd';
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
      <p className={classes.headline}>{t('Issues')}</p>
      <Result status="success" title="No issues detected" />
    </div>
  );
};

export default Issues;
