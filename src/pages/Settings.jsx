import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useState, useEffect, useCallback } from 'react';
import { Select, Space, Typography, Divider, message } from 'antd';
import { createUseStyles } from 'react-jss';
import AccountManagement from '../components/AccountManagement';
import AssetManagement from '../components/AssetManagement';

const { Option } = Select;
const { Title } = Typography;

const useStyles = createUseStyles({
  page: {
    padding: 16,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
});

const Settings = () => {
  const { t, i18n } = useTranslation();
  const classes = useStyles();
  const [settings, setSettings] = useState({});

  const changeLanguage = async (value) => {
    setSettings({ language: value, ...settings });
    i18n.changeLanguage(value);
    await axios.post('http://localhost:5208/settings/language', {
      language: value,
    });
  };

  const { language } = i18n;

  const fetchSettings = useCallback(() => {
    axios
      .get('http://localhost:5208/settings')
      .then((response) => {
        setSettings({ ...response.data, language: language });
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      });
  }, [language]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return (
    <div className={classes.page}>
      <Title level={4}>{t('General')}</Title>
      <Space>
        <span>{t('Language')}</span>
        <Select
          onChange={changeLanguage}
          value={language}
          style={{ width: 120 }}
        >
          <Option value="de">Deutsch</Option>
          <Option value="en">English</Option>
        </Select>
      </Space>
      <Divider />
      <Space>
        <AccountManagement />
      </Space>
      <Divider />
      <Space>
        <AssetManagement />
      </Space>
    </div>
  );
};

export default Settings;
