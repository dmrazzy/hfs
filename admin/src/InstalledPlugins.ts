import { apiCall, useApiList } from './api'
import { createElement as h, Fragment } from 'react'
import { Alert, Box, Tooltip } from '@mui/material'
import { DataGrid } from '@mui/x-data-grid'
import { Delete, Error, GitHub, PlayCircle, Settings, StopCircle, SystemUpdateAlt } from '@mui/icons-material'
import { IconBtn } from './misc'
import { formDialog, toast } from './dialog'
import _ from 'lodash'
import { BoolField, Field, MultiSelectField, NumberField, SelectField, StringField } from './Form'
import { ArrayField } from './ArrayField'

export default function InstalledPlugins({ updates }: { updates?: true }) {
    const { list, setList, error, initializing } = useApiList(updates ? 'get_plugin_updates' : 'get_plugins')
    if (error)
        return h(Alert, { severity: 'error' }, error)
    return h(DataGrid, {
        rows: list.length ? list : [], // workaround for DataGrid bug causing 'no rows' message to be not displayed after 'loading' was also used
        loading: initializing,
        disableColumnSelector: true,
        disableColumnMenu: true,
        columnVisibilityModel: {
            started: !updates,
        },
        localeText: updates && { noRowsLabel: "No updates available. Only online plugins are checked." },
        columns: [
            {
                field: 'id',
                headerName: "name",
                flex: .3,
                minWidth: 150,
                renderCell({ row, value }) {
                    return h(Fragment, {},
                        value,
                        typeof row.badApi === 'string' && h(Tooltip, { title: row.badApi, children: h(Error, { color: 'warning', sx: { ml: 1 } }) }),
                        repoLink(row.repo),
                    )
                }
            },
            {
                field: 'started',
                width: 180,
                valueFormatter: ({ value }) => !value ? "off" : new Date(value as string).toLocaleString()
            },
            {
                field: 'version',
                width: 70,
            },
            {
                field: 'description',
                flex: 1,
            },
            {
                field: "actions",
                width: 120,
                align: 'center',
                headerAlign: 'center',
                hideSortIcons: true,
                disableColumnMenu: true,
                renderCell({ row }) {
                    const { config, id } = row
                    if (updates)
                        return h(IconBtn, {
                            icon: SystemUpdateAlt,
                            title: "Update",
                            async onClick() {
                                await apiCall('update_plugin', { id })
                                setList(list.filter(x => x.id !== id))
                            }
                        })
                    return h('div', {},
                        h(IconBtn, row.started ? {
                            icon: StopCircle,
                            title: `Stop ${id}`,
                            onClick: () =>
                                apiCall('set_plugin', { id, enabled: false }).then(() =>
                                    toast("Plugin is stopping", h(StopCircle, { color: 'warning' })))
                        } : {
                            icon: PlayCircle,
                            title: `Start ${id}`,
                            onClick: () =>
                                apiCall('set_plugin', { id, enabled: true }).then(() =>
                                    toast("Plugin is starting", h(PlayCircle, { color: 'success' }))),
                        }),
                        h(IconBtn, {
                            icon: Settings,
                            title: "Configuration",
                            disabled: !config && "No configuration available for this plugin",
                            async onClick() {
                                const pl = await apiCall('get_plugin', { id })
                                const values = await formDialog({
                                    title: `${id} configuration`,
                                    fields: [ h(Box, {}, row.description), ...makeFields(config) ],
                                    values: pl.config,
                                    ...row.configDialog,
                                })
                                if (!values || _.isEqual(pl.config, values)) return
                                await apiCall('set_plugin', { id, config: values })
                                toast("Configuration saved")
                            }
                        }),
                        h(IconBtn, {
                            icon: Delete,
                            title: "Uninstall",
                            async onClick() {
                                await apiCall('uninstall_plugin', { id })
                                toast("Plugin uninstalled")
                            }
                        }),
                    )
                }
            },
        ]
    })
}

function makeFields(config: any) {
    return Object.entries(config).map(([k,o]: [string,any]) => {
        if (!_.isPlainObject(o))
            return o
        let { type, defaultValue, fields, ...rest } = o
        const comp = (type2comp as any)[type] as Field<any> | undefined
        if (comp === ArrayField)
            fields = makeFields(fields)
        if (defaultValue !== undefined && type === 'boolean')
            rest.placeholder = `Default value is ${JSON.stringify(defaultValue)}`
        return { k, comp, fields, ...rest }
    })
}

const type2comp = {
    string: StringField,
    number: NumberField,
    boolean: BoolField,
    select: SelectField,
    multiselect: MultiSelectField,
    array: ArrayField,
}

export function repoLink(repo?: string) {
    return repo && h(IconBtn, {
        icon: GitHub,
        title: "Open web page",
        link: 'https://github.com/' + repo,
    })
}