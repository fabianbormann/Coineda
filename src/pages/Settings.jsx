import { useTranslation } from 'react-i18next';

const Settings = () => {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('Settings')}</h1>
    </div>
  );
};

export default Settings;
