import { useTranslation } from 'react-i18next';

const Dashboard = () => {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('Dashboard')}</h1>
    </div>
  );
};

export default Dashboard;
