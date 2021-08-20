import { useTranslation } from 'react-i18next';
import { Divider, Typography, Empty } from 'antd';
import { createUseStyles } from 'react-jss';

const { Title } = Typography;

const useStyles = createUseStyles({
  actions: {
    marginTop: 0,
    marginBottom: 12,
  },
  page: {
    padding: 16,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
});

const TaxReports = () => {
  const { t } = useTranslation();
  const classes = useStyles();

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tax Reports')}</Title>
      <Divider className={classes.actions} />
      <Empty description={t('Tax report not implemented yet')} />
    </div>
  );
};

export default TaxReports;
