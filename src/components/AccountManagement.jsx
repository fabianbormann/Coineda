import { useState, useEffect, useContext } from 'react';
import {
  ReloadOutlined,
  DownOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import {
  Button,
  Avatar,
  message,
  Popconfirm,
  Modal,
  Input,
  Dropdown,
  Menu,
} from 'antd';
import { createUseStyles } from 'react-jss';
import GeoPattern from 'geopattern';
import { useTranslation } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';

const useStyles = createUseStyles({
  name: {
    marginLeft: 8,
  },
  row: {
    width: 176,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: 16,
    '& > span:first-child': {
      width: 80,
    },
    '& > .ant-input': {
      width: 'unset',
      flexGrow: 1,
    },
    '& > *': {
      marginLeft: 8,
    },
  },
  actions: {
    display: 'flex',
    '& > :first-child': {
      marginRight: 4,
    },
  },
  selected: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    '& > :first-child': {
      minWidth: 180,
    },
  },
  headline: {
    marginTop: 0,
    marginBottom: 12,
    fontWeight: 500,
    fontSize: '1.1rem',
    color: '#2F4858',
  },
});

const AccountManagement = () => {
  const [settings, updateSettings] = useContext(SettingsContext);
  const classes = useStyles();
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [accountName, setAccountName] = useState('');

  const generateRandomString = () =>
    (Math.random().toString(36) + '00000000000000000').slice(2, 8 + 2);

  const [pattern, setPattern] = useState(generateRandomString());

  useEffect(() => {
    const fetchAccounts = async () => {
      setAccounts(await storage.accounts.getAll());
    };

    fetchAccounts();
  }, []);

  const submit = async () => {
    try {
      await storage.accounts.add(accountName, pattern);
      const updatedAccounts = await storage.accounts.getAll();
      setAccounts(updatedAccounts);
      updateSettings((prevSettings) => ({
        ...prevSettings,
        account: updatedAccounts[updatedAccounts.length - 1],
      }));
    } catch (error) {
      message.error(
        'Failed to save the account. Please restart the application.'
      );
      console.warn(error);
    } finally {
      setAccountName('');
      setPattern(generateRandomString());
      setDialogOpen(false);
    }
  };

  const menu = (
    <Menu
      onClick={({ key }) => {
        updateSettings((prevSettings) => ({
          ...prevSettings,
          account: accounts.find((account) => account.name === key),
        }));
        localStorage.setItem('activeAccount', key);
      }}
    >
      {accounts.map((account) => (
        <Menu.Item key={account.name}>
          <div className={classes.row}>
            <Avatar
              style={{
                backgroundImage: GeoPattern.generate(
                  account.pattern
                ).toDataUrl(),
                backgroundSize: 'cover',
              }}
            />
            <span className={classes.name}>{account.name}</span>
          </div>
        </Menu.Item>
      ))}
    </Menu>
  );

  const editAccount = () => {
    setDialogOpen(true);
  };
  const deleteAccount = () => {};

  return (
    <>
      <p className={classes.headline}>{t('Account Management')}</p>
      <div className={classes.content} style={{ marginTop: 12 }}>
        <div className={classes.selected}>
          <Dropdown overlay={menu}>
            <span onClick={(e) => e.preventDefault()}>
              <Avatar
                style={{
                  backgroundImage: GeoPattern.generate(
                    settings.account.pattern
                  ).toDataUrl(),
                  backgroundSize: 'cover',
                }}
              />
              <span className={classes.name}>{settings.account.name}</span>
              <DownOutlined style={{ marginLeft: 8 }} />
            </span>
          </Dropdown>
          <div className={classes.actions}>
            <Button icon={<EditOutlined />} onClick={editAccount} />
            <Popconfirm
              title="Are you sure to delete this account?"
              onConfirm={deleteAccount}
              okText="Yes"
              cancelText="No"
            >
              <Button danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        </div>
        <Button
          type="primary"
          style={{ marginTop: 12 }}
          onClick={() => setDialogOpen(true)}
        >
          {t('Add Account')}
        </Button>
      </div>
      <Modal
        visible={dialogOpen}
        onOk={submit}
        title={t('Add Account')}
        okButtonProps={{
          disabled: accountName.length === 0,
        }}
        onCancel={() => setDialogOpen(false)}
      >
        <div className={classes.content}>
          <div className={classes.field}>
            <span>Pattern:</span>
            <Avatar
              style={{
                backgroundImage: GeoPattern.generate(pattern).toDataUrl(),
                backgroundSize: 'cover',
              }}
            />
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => {
                setPattern(generateRandomString());
              }}
            >
              New Pattern
            </Button>
          </div>
          <div className={classes.field}>
            <span>Name:</span>
            <Input
              placeholder="Account Name"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
            />
          </div>
        </div>
      </Modal>
    </>
  );
};

export default AccountManagement;
