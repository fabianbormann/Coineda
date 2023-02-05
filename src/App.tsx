import React, { useState, useContext, useEffect } from 'react';
import {
  HashRouter as Router,
  Routes,
  Route,
  Link,
  useLocation,
} from 'react-router-dom';
import { Dashboard, Tracking, TaxReports, Settings, Wallets } from './pages';
import { useTranslation } from 'react-i18next';
import { SettingsContext, defaultSettings } from './SettingsContext';
import storage from './persistence/storage';
import MuiDrawer from '@mui/material/Drawer';
import SwipeableDrawer from '@mui/material/SwipeableDrawer';
import { styled, useTheme } from '@mui/material/styles';
import Footer from './components/Footer';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import { ChevronLeft } from '@mui/icons-material';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import SettingsIcon from '@mui/icons-material/Settings';
import MenuIcon from '@mui/icons-material/Menu';
import DashboardIcon from '@mui/icons-material/Dashboard';
import MuiAppBar, { AppBarProps as MuiAppBarProps } from '@mui/material/AppBar';
import {
  Box,
  Divider,
  Grid,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Typography,
  useMediaQuery,
  Link as MuiLink,
  Chip,
} from '@mui/material';
import {
  CoinedaAccount,
  CoinedaSettings,
  NavigationItemProps,
} from './global/types';

const drawerWidth: number = 240;

const DesktopDrawer = styled(MuiDrawer, {
  shouldForwardProp: (prop) => prop !== 'open',
})(({ theme, open }) => ({
  '& .MuiDrawer-paper': {
    position: 'relative',
    whiteSpace: 'nowrap',
    width: drawerWidth,
    transition: theme.transitions.create('width', {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
    boxSizing: 'border-box',
    ...(!open && {
      overflowX: 'hidden',
      transition: theme.transitions.create('width', {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.leavingScreen,
      }),
      width: theme.spacing(7),
      [theme.breakpoints.up('sm')]: {
        width: theme.spacing(9),
      },
    }),
  },
}));

const Logo = styled('div')(() => ({
  background: 'url("./logo192.png")',
  width: 32,
  height: 32,
  backgroundSize: 'contain',
}));

const Content = styled('main')(({ theme }) => ({
  backgroundColor:
    theme.palette.mode === 'light'
      ? theme.palette.grey[100]
      : theme.palette.grey[900],
  flexGrow: 1,
  height: '100vh',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
}));

interface AppBarProps extends MuiAppBarProps {
  open?: boolean;
}

const AppBar = styled(MuiAppBar, {
  shouldForwardProp: (prop) => prop !== 'open',
})<AppBarProps>(({ theme, open }) => ({
  zIndex: theme.zIndex.drawer + 1,
  transition: theme.transitions.create(['width', 'margin'], {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  ...(open && {
    transition: theme.transitions.create(['width', 'margin'], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
  }),
}));

const Main = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const isMobileView = useMediaQuery(theme.breakpoints.down('sm'));
  const [drawerOpen, setDrawerOpen] = useState(!isMobileView);
  const { settings, setSettings } = useContext(SettingsContext);
  const { account } = settings;
  const location = useLocation();
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);

  const handleInfoPopoverOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorElement(event.currentTarget);
  };

  const handleInfoPopoverClose = () => {
    setAnchorElement(null);
  };

  const getPageTitle = () => {
    if (location.pathname === '/' || location.pathname === '/dashboard') {
      return t('Dashboard');
    } else if (location.pathname === '/tracking') {
      return t('Tracking');
    } else if (location.pathname === '/reports') {
      return t('Tax Reports');
    } else if (location.pathname === '/wallets') {
      return t('Wallets');
    } else if (location.pathname === '/settings') {
      return t('Settings');
    }
    return 'Coineda';
  };

  const NavigationItem = (props: NavigationItemProps) => (
    <ListItemButton
      onClick={() => {
        if (isMobileView) {
          toggleDrawer();
        }
      }}
      component={Link}
      to={props.location}
    >
      <ListItemIcon>{props.icon}</ListItemIcon>
      <ListItemText primary={props.title} />
    </ListItemButton>
  );

  useEffect(() => {
    storage.accounts.getAll().then((accounts: Array<CoinedaAccount>) => {
      if (accounts.length === 0) {
        accounts = [
          {
            id: 1,
            name: 'Coineda',
            pattern: 0,
          },
        ];

        storage.accounts.add(accounts[0].name, accounts[0].pattern);
      }

      let activeAccount = localStorage.getItem('activeAccount');
      let selectedAccount = accounts[0];

      if (typeof activeAccount !== 'undefined') {
        selectedAccount =
          accounts.find((account) => account.name === activeAccount) ||
          selectedAccount;
      }

      setSettings(
        (previousSettings: CoinedaSettings) =>
          ({
            ...previousSettings,
            account: selectedAccount,
          } as CoinedaSettings)
      );
    });
  }, [setSettings]);

  const toggleDrawer = () => {
    setDrawerOpen(!drawerOpen);
  };

  const drawer = (
    <>
      <Toolbar
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: [1],
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: 8,
          }}
        >
          <div style={{ minWidth: 56 }}>
            <Logo sx={{ filter: `hue-rotate(${account.pattern}deg)` }} />
          </div>
          <div>
            <Typography>{account.name}</Typography>
          </div>
        </div>
        <div style={{ flexGrow: 1 }} />
        <IconButton onClick={toggleDrawer}>
          <ChevronLeft />
        </IconButton>
      </Toolbar>
      <Divider />
      <List component="nav">
        <NavigationItem
          title={t('Dashboard')}
          location="/"
          icon={<DashboardIcon />}
        />
        <NavigationItem
          title={t('Tracking')}
          location="/tracking"
          icon={<NoteAddIcon />}
        />
        <NavigationItem
          title={t('Tax Reports')}
          location="/reports"
          icon={<AccountBalanceIcon />}
        />
        <NavigationItem
          title={t('Wallets')}
          location="/wallets"
          icon={<AccountBalanceWalletIcon />}
        />
        <NavigationItem
          title={t('Settings')}
          location="/settings"
          icon={<SettingsIcon />}
        />
      </List>
      <Grid container sx={{ padding: 2, alignItems: 'flex-end', flexGrow: 1 }}>
        <IconButton aria-haspopup="true" onMouseEnter={handleInfoPopoverOpen}>
          <HelpOutlineIcon
            sx={{
              fontSize: '1.5rem',
              color: 'rgba(0, 0, 0, 0.54)',
              '&:hover': {
                color: theme.palette.primary.main,
              },
            }}
          />
        </IconButton>
        <Popover
          open={Boolean(anchorElement)}
          onClose={handleInfoPopoverClose}
          PaperProps={{ onMouseLeave: handleInfoPopoverClose }}
          anchorEl={anchorElement}
          disableRestoreFocus
        >
          <Grid sx={{ p: 2 }}>
            <Grid container sx={{ alignItems: 'center' }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{`${t(
                'Coineda Version'
              )} ${process.env.REACT_APP_VERSION}`}</Typography>
              <Chip
                sx={{ ml: 1 }}
                size="small"
                label={t('GPLv3 License')}
                color="secondary"
                clickable
                component="a"
                target="_blank"
                rel="noreferrer"
                href="https://github.com/fabianbormann/Coineda/blob/main/LICENSE"
              />
            </Grid>
            <Typography sx={{ mt: 1 }} variant="body2">
              {t('If you find any bug open a')}
              <MuiLink
                target="_blank"
                rel="noreferrer"
                href="https://github.com/fabianbormann/Coineda/issues/new"
              >
                {t('new issue on GitHub')}
              </MuiLink>
            </Typography>
          </Grid>
        </Popover>
      </Grid>
    </>
  );

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar
        sx={{
          marginLeft: { xs: 0, sm: drawerWidth },
          zIndex: { xs: 1, sm: 1201 },
          width:
            drawerOpen && !isMobileView
              ? `calc(100% - ${drawerWidth}px)`
              : '100%',
        }}
        position="absolute"
        open={drawerOpen}
      >
        <Toolbar sx={{ pr: '24px' }}>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="open drawer"
            onClick={toggleDrawer}
            sx={{
              marginRight: '36px',
              ...(drawerOpen && { display: 'none' }),
            }}
          >
            <MenuIcon />
          </IconButton>
          <Typography
            component="h1"
            variant="h6"
            color="inherit"
            noWrap
            sx={{
              flexGrow: 1,
              textAlign: 'center',
              ...(!drawerOpen && isMobileView && { marginLeft: '-28px' }),
            }}
          >
            {getPageTitle()}
          </Typography>
        </Toolbar>
      </AppBar>
      <DesktopDrawer
        variant="permanent"
        open={drawerOpen}
        sx={{ display: { xs: 'none', sm: 'block' } }}
      >
        {drawer}
      </DesktopDrawer>
      <SwipeableDrawer
        open={drawerOpen}
        onClose={toggleDrawer}
        onOpen={toggleDrawer}
        sx={{
          '& .MuiDrawer-paper': {
            width: drawerWidth,
          },
          display: { xs: 'block', sm: 'none' },
        }}
      >
        {drawer}
      </SwipeableDrawer>
      <Content>
        <Toolbar />

        <Grid container sx={{ flexGrow: 1 }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tracking/*" element={<Tracking />} />
            <Route path="/reports/*" element={<TaxReports />} />
            <Route path="/wallets/*" element={<Wallets />} />
            <Route path="/settings/*" element={<Settings />} />
          </Routes>
        </Grid>

        <Footer />
      </Content>
    </Box>
  );
};

const App = () => {
  const [settings, setSettings] = useState<CoinedaSettings>(defaultSettings);

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      <Router>
        <Main />
      </Router>
    </SettingsContext.Provider>
  );
};

export default App;
