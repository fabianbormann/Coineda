import React from 'react';
import { useState, useContext } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import { importFiles } from '../helper/import';
import { useDropzone, ErrorCode } from 'react-dropzone';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Snackbar,
} from '@mui/material';
import { ImportDialogProps, MessageType } from '../global/types';

const Dropzone = () => {
  const { acceptedFiles, getRootProps, getInputProps } = useDropzone({
    disabled: true,
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

  const files = acceptedFiles.map((file) => (
    <li key={file.name}>
      {file.name} - {file.size} bytes
    </li>
  ));

  return (
    <section className="container">
      <div {...getRootProps({ className: 'dropzone disabled' })}>
        <input {...getInputProps()} />
        <Trans i18nKey="UploadFieldText">
          Click or drag file to this area to upload
        </Trans>
      </div>
      <aside>
        <h4>Files</h4>
        <ul>{files}</ul>
      </aside>
    </section>
  );
};

const ImportDialog = (props: ImportDialogProps) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState([]);
  const { settings } = useContext(SettingsContext);
  const { account } = settings;
  const [uploading, setUploading] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const { visible, onClose } = props;

  const handleUpload = async () => {
    try {
      const { inserts, duplicates, errors } = await importFiles(
        files,
        account.id
      );

      if (duplicates === 0 && errors === 0 && inserts > 0) {
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

      setFiles([]);
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
          <Dropzone />
        </DialogContent>
        <DialogActions>
          <Button disabled={files.length < 1 || uploading} onClick={submit}>
            Cancel
          </Button>
          <Button onClick={() => onClose()}>OK</Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default ImportDialog;
