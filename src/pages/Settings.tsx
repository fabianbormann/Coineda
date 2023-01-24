import React from 'react';
import { useTranslation } from 'react-i18next';
import AccountManagement from '../components/AccountManagement';
import AssetManagement from '../components/AssetManagement';

const Settings = () => {
  const { t, i18n } = useTranslation();

  const changeLanguage = (value: string) => {
    i18n.changeLanguage(value);
  };

  let { language } = i18n;
  language = language.split('-')[0];

  return (
    <div>
      {/*<p>{t('General') as string}</p>
      <Space>
        <span>{t('Language') as string}</span>
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
  </Space>*/}
    </div>
  );
};

export default Settings;
