import { Table, Divider, Typography, Space, Button } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import AddTransactionsDialog from '../dialogs/AddTransactionDialog';

const { Title } = Typography;

const useStyles = createUseStyles({
  actions: {
    marginTop: 0,
    marginBottom: 24,
  },
  page: {
    padding: 16,
  },
});

const Tracking = () => {
  const { t } = useTranslation();
  const [addDialogVisible, setAddDialogVisible] = useState(false);
  const classes = useStyles();

  const dataSource = [
    {
      type: 'Transaction',
      from: '0.01 BTC',
      to: '0.1 ETH',
      fee: '0.002 ETH',
      date: '2015-28-05 10:27:01',
      exchange: 'Binance',
      comment: 'Switch from Bitcoin to ETH',
    },
    {
      type: 'Buy',
      from: '100 EUR',
      to: '0.01 BTC',
      fee: '0 EUR',
      date: '2015-13.05 21:00:17',
      exchange: 'Binance',
      comment: 'Buy Bitcoin',
    },
  ];

  const columns = [
    {
      title: t('Type'),
      dataIndex: 'type',
      key: 'type',
    },
    {
      title: t('From'),
      dataIndex: 'from',
      key: 'from',
    },
    {
      title: t('To'),
      dataIndex: 'to',
      key: 'to',
    },
    {
      title: t('Fee'),
      dataIndex: 'fee',
      key: 'fee',
    },
    {
      title: t('Date'),
      dataIndex: 'date',
      key: 'date',
    },
    {
      title: t('Exchange'),
      dataIndex: 'exchange',
      key: 'exchange',
    },
    {
      title: t('Comment'),
      dataIndex: 'comment',
      key: 'comment',
    },
  ];

  const closeAddDialog = () => setAddDialogVisible(false);
  const openAddDialog = () => setAddDialogVisible(true);

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tracking')}</Title>
      <Divider />
      <Space className={classes.actions}>
        <Button type="primary" onClick={openAddDialog}>
          {t('Add')}
        </Button>
        <Button type="primary">{t('Import')}</Button>
      </Space>
      <Table dataSource={dataSource} columns={columns} />
      <AddTransactionsDialog
        visible={addDialogVisible}
        onClose={closeAddDialog}
      />
    </div>
  );
};

export default Tracking;
