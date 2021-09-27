import { useTranslation } from 'react-i18next';
import {
  Divider,
  Typography,
  Empty,
  message,
  Spin,
  DatePicker,
  Statistic,
  Button,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import { useState, useContext, useCallback, useEffect } from 'react';
import { SettingsContext } from '../SettingsContext';
import axios from 'axios';
import moment from 'moment';

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
  const [settings] = useContext(SettingsContext);
  const [summary, setSummary] = useState({
    realizedGains: [],
    unrealizedGains: [],
  });
  const [selectedYear, setSelectedYear] = useState(new Date());
  const [loading, setLoading] = useState(false);

  const { account } = settings;

  const fetchSummary = useCallback(() => {
    setLoading(true);
    axios
      .get('http://localhost:5208/tax/' + account.id)
      .then((response) => {
        setSummary(response.data);
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      })
      .finally(() => setLoading(false));
  }, [account]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tax Reports')}</Title>
      <Divider className={classes.actions} />
      {loading && <Spin />}

      {summary.realizedGains.length > 0 ||
      summary.unrealizedGains.length > 0 ? (
        <div>
          <DatePicker
            value={moment(selectedYear)}
            onChange={(date, dateString) => setSelectedYear(date)}
            picker="year"
          />
          <Statistic
            valueStyle={{ color: '#3f8600' }}
            title={t('Tax relevant gains')}
            value={`+817 EUR`}
          />
          <p>You need to pay ~213,60 EUR tax for 2021.</p>
          <Button icon={<DownloadOutlined />}>Download</Button>
          <Title level={4}>{t('Realized Gains')}</Title>
          {summary.realizedGains.map((transaction) => (
            <div>
              {transaction.currency} {transaction.gain}
            </div>
          ))}
          <Title level={4}>{t('Unrealized Gains')}</Title>
          {summary.unrealizedGains.map((transaction) => (
            <div>
              {transaction.currency} {transaction.gain}
            </div>
          ))}
        </div>
      ) : (
        !loading && <Empty description={t('No Transactions')} />
      )}
    </div>
  );
};

export default TaxReports;
