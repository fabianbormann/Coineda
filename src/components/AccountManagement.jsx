import { useState, useEffect, useContext } from 'react';
import {
  ReloadOutlined,
  DownOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import {
  Button,
  message,
  Popconfirm,
  Modal,
  Input,
  Dropdown,
  Menu,
} from 'antd';
import { createUseStyles } from 'react-jss';
import Blockies from 'react-blockies';
import { useTranslation } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';

const DialogMode = Object.freeze({
  ADD: 'add',
  EDIT: 'edit',
});

const useStyles = createUseStyles({
  name: {
    marginLeft: 8,
  },
  row: {
    width: 176,
    display: 'flex',
    alignItems: 'center',
  },
  blockie: {
    borderRadius: '50%',
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
      display: 'flex',
      alignItems: 'center',
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
  const [accountName, setAccountName] = useState('');

  const generateRandomString = () =>
    (Math.random().toString(36) + '00000000000000000').slice(2, 8 + 2);

  const [pattern, setPattern] = useState(generateRandomString());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTitle, setDialogTitle] = useState(t('Add Account'));
  const [dialogMode, setDialogMode] = useState(DialogMode.ADD);

  useEffect(() => {
    const fetchAccounts = async () => {
      setAccounts(await storage.accounts.getAll());
    };

    fetchAccounts();
  }, []);

  const submit = async () => {
    if (dialogMode === DialogMode.ADD) {
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
        setDialogOpen(false);
      }
    } else {
      try {
        await storage.accounts.put({
          id: settings.account.id,
          name: accountName,
          pattern: pattern,
        });
        const updatedAccounts = await storage.accounts.getAll();
        setAccounts(updatedAccounts);
        updateSettings((prevSettings) => ({
          ...prevSettings,
          account: updatedAccounts.find(
            (account) => account.id === settings.account.id
          ),
        }));
      } catch (error) {
        message.error(
          'Failed to save the account. Please restart the application.'
        );
        console.warn(error);
      } finally {
        setDialogOpen(false);
      }
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
            <Blockies
              seed={account.pattern}
              size={8}
              className={classes.blockie}
            />
            <span className={classes.name}>{account.name}</span>
          </div>
        </Menu.Item>
      ))}
    </Menu>
  );

  const addAccount = () => {
    setDialogTitle(t('Add Account'));
    setDialogMode(DialogMode.ADD);
    setPattern(generateRandomString());
    setAccountName('');
    setDialogOpen(true);
  };

  const editAccount = () => {
    setDialogTitle(t('Edit Account'));
    setDialogMode(DialogMode.EDIT);
    setPattern(settings.account.pattern);
    setAccountName(settings.account.name);
    setDialogOpen(true);
  };

  const deleteAccount = async () => {
    if (settings.account.id === 1) {
      message.warn(
        t('This account is protected by default and cannot be removed')
      );
      return;
    }

    try {
      await storage.accounts.delete(settings.account.id);
      const updatedAccounts = await storage.accounts.getAll();
      setAccounts(updatedAccounts);
      updateSettings((prevSettings) => ({
        ...prevSettings,
        account: updatedAccounts[0],
      }));
    } catch (error) {
      message.error(
        'Failed to delete the account. Please try again or contact the support.'
      );
      console.warn(error);
    }
  };

  return (
    <>
      <p className={classes.headline}>{t('Account Management')}</p>
      <div className={classes.content} style={{ marginTop: 12 }}>
        <div className={classes.selected}>
          <Dropdown overlay={menu}>
            <span onClick={(e) => e.preventDefault()}>
              <Blockies
                seed={settings.account.pattern}
                size={8}
                className={classes.blockie}
              />
              <span className={classes.name}>{settings.account.name}</span>
              <DownOutlined style={{ marginLeft: 8 }} />
            </span>
          </Dropdown>
          <div className={classes.actions}>
            <Button icon={<EditOutlined />} onClick={editAccount} />
            <Popconfirm
              title={t('Are you sure to delete this account?')}
              onConfirm={deleteAccount}
              okText={t('Yes')}
              cancelText={t('No')}
            >
              <Button danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        </div>
        <Button type="primary" style={{ marginTop: 12 }} onClick={addAccount}>
          {t('Add Account')}
        </Button>
      </div>
      <Modal
        visible={dialogOpen}
        onOk={submit}
        title={dialogTitle}
        okButtonProps={{
          disabled: accountName.length === 0,
        }}
        onCancel={() => setDialogOpen(false)}
      >
        <div className={classes.content}>
          <div className={classes.field}>
            <span>Pattern:</span>
            <Blockies seed={pattern} size={8} className={classes.blockie} />
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
