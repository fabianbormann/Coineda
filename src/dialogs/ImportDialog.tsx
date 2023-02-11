import React from 'react';
import { useState, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import { importFiles } from '../helper/import';
import { useDropzone, ErrorCode } from 'react-dropzone';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Paper,
  Snackbar,
  Typography,
} from '@mui/material';
import { ImportDialogProps, MessageType } from '../global/types';

const ImportDialog = (props: ImportDialogProps) => {
  const { t } = useTranslation();
  const { settings } = useContext(SettingsContext);
  const { account } = settings;
  const [uploading, setUploading] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const { visible, onClose } = props;
  const { acceptedFiles, getRootProps, getInputProps, open } = useDropzone({
    accept: {
      'text/plain': ['.cnd'],
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
        '.xlsx',
      ],
    },
    validator: (file) => {
      if (
        !file.name.endsWith('.cnd') ||
        file.name.endsWith('.xlsx') ||
        file.name.endsWith('.csv')
      ) {
        return {
          message: '',
          code: ErrorCode.FileInvalidType,
        };
      } else {
        return null;
      }
    },
  });

  const { ref, ...rootProps } = getRootProps();

  const handleUpload = async () => {
    try {
      const { inserts, duplicates, errors } = await importFiles(
        acceptedFiles.map((acceptedFile) => ({ ...acceptedFile, data: null })),
        account.id
      );

      if (duplicates === 0 && errors.length === 0 && inserts > 0) {
        setSnackbarMessage(
          t('Transactions successfully uploaded', {
            inserts: inserts,
          }) as string
        );
        setSnackbarType('success');
        setSnackbarOpen(true);
      } else {
        setSnackbarMessage(
          t('Transactions partially uploaded', {
            inserts,
            duplicates,
            errors,
          }) as string
        );
        setSnackbarType('warning');
        setSnackbarOpen(true);
      }

      onClose();
    } catch (error) {
      setSnackbarMessage('Upload failed. Please try again.');
      setSnackbarType('error');
      setSnackbarOpen(true);
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!uploading) {
      setUploading(true);
      handleUpload();
    }
  };

  const handleSnackbarClose = (
    event?: React.SyntheticEvent | Event,
    reason?: string
  ) => {
    if (reason === 'clickaway') {
      return;
    }
    setSnackbarOpen(false);
  };

  return (
    <>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={handleSnackbarClose}
      >
        <Alert
          onClose={handleSnackbarClose}
          severity={snackbarType}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
      <Dialog onClose={() => onClose()} open={visible}>
        <DialogContent>
          <Paper
            onClick={open}
            variant="outlined"
            sx={{ p: 4 }}
            {...rootProps}
            ref={ref}
          >
            <input {...getInputProps()} />
            <Typography>
              {t('Click or drag files to this area to upload')}
            </Typography>
            <aside>
              <ul>
                {acceptedFiles.map((file) => (
                  <li key={file.name}>
                    {file.name} - {file.size} bytes
                  </li>
                ))}
              </ul>
            </aside>
          </Paper>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button
            disabled={acceptedFiles.length < 1 || uploading}
            onClick={submit}
          >
            OK
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default ImportDialog;
